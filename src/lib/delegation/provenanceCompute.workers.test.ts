/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { AccountUpdateHistoryRow, DrepDelegatorRow, TxInfoCertsRow } from '../koios/client';
import { computeProvenance, type ProvenanceKoios } from './provenanceCompute.js';

const db = () => env.DB as D1Database;
const SELF = 'drep1selfprov';
const OTHER = 'drep1otherprov';

const hist = (addr: string, tx: string, epoch: number, slot: number): AccountUpdateHistoryRow =>
  ({ stake_address: addr, action_type: 'delegation_drep', tx_hash: tx, epoch_no: epoch, absolute_slot: slot });
const cert = (addr: string, drep: string) =>
  ({ type: 'vote_delegation', info: { stake_address: addr, drep_id: drep } });

// Accounts: arr (came from OTHER @651), fresh (first-ever @650),
// recert (stint since 500, re-cert @649 -> must reclassify to base),
// old (epoch_no 500, proven base by the pre-filter, no lookups).
function fakeKoios(): ProvenanceKoios & { historyAddrs: string[]; txRequests: string[][] } {
  const state = { historyAddrs: [] as string[], txRequests: [] as string[][] };
  return {
    ...state,
    async drepDelegators(_d, _l = 1000, offset = 0): Promise<DrepDelegatorRow[]> {
      if (offset > 0) return [];
      return [
        { stake_address: 'stake1arr', amount: '3000000', epoch_no: 651 },
        { stake_address: 'stake1fresh', amount: '1000000', epoch_no: 650 },
        { stake_address: 'stake1recert', amount: '7000000', epoch_no: 649 },
        { stake_address: 'stake1old', amount: '9000000', epoch_no: 500 },
      ];
    },
    async accountUpdateHistoryBatch(addrs) {
      state.historyAddrs.push(...[...addrs].sort());
      return [
        hist('stake1arr', 'txPrev', 600, 1), hist('stake1arr', 'txArr', 651, 2),
        hist('stake1fresh', 'txFresh', 650, 3),
        hist('stake1recert', 'txStint', 500, 4), hist('stake1recert', 'txRe', 649, 5),
      ];
    },
    async txInfoCertsBatch(hashes): Promise<TxInfoCertsRow[]> {
      state.txRequests.push([...hashes].sort());
      return [
        { tx_hash: 'txPrev', certificates: [cert('stake1arr', OTHER)] },
        { tx_hash: 'txArr', certificates: [cert('stake1arr', SELF)] },
        { tx_hash: 'txFresh', certificates: [cert('stake1fresh', SELF)] },
        { tx_hash: 'txStint', certificates: [cert('stake1recert', SELF)] },
        { tx_hash: 'txRe', certificates: [cert('stake1recert', SELF)] },
      ];
    },
  };
}

describe('computeProvenance', () => {
  it('classifies, reclassifies the re-cert stint into base, joins names, computes coverage', async () => {
    await db().prepare(
      `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at, slug, name)
       VALUES (?, 'registered', 1, 0, 0, ?, ?)`,
    ).bind(OTHER, 'other-prov', 'Other DRep').run();

    const koios = fakeKoios();
    const payload = await computeProvenance({
      koios, db: db(), drepId: SELF, windowEpochs: 12, currentEpoch: 652, now: 123456,
    });

    // Only the three candidates get history lookups, the pre-filtered base none.
    expect(koios.historyAddrs).toEqual(['stake1arr', 'stake1fresh', 'stake1recert']);
    // Every delegation tx of the candidates is resolved (deduped, one batch).
    expect(koios.txRequests).toEqual([['txArr', 'txFresh', 'txPrev', 'txRe', 'txStint']]);

    expect(payload.version).toBe(1);
    expect(payload.computedAt).toBe(123456);
    expect(payload.currentEpoch).toBe(652);
    // base = pre-filtered old (9M) + reclassified recert (7M)
    expect(payload.base).toEqual({ count: 2, amount: '16000000' });
    expect(payload.reclassifiedBaseCount).toBe(1);
    expect(payload.sources).toEqual([
      { type: 'drep', drepId: OTHER, name: 'Other DRep', count: 1, amount: '3000000', returningCount: 0 },
      { type: 'new', count: 1, amount: '1000000', returningCount: 0 },
    ]);
    expect(payload.coverage).toEqual({
      analyzedCandidateCount: 3, totalCandidateCount: 3,
      analyzedCandidateAmount: '11000000', totalCandidateAmount: '11000000',
    });
    expect(payload.notAnalyzed).toBeNull();
    expect(payload.unresolved).toBeNull();
    expect(payload.returningTotal).toBe(0);
  });

  it('counts a candidate whose history cannot confirm the stint as unresolved, never as an arrival', async () => {
    const koios: ProvenanceKoios = {
      async drepDelegators(_d, _l = 1000, offset = 0) {
        return offset > 0 ? [] : [{ stake_address: 'stake1odd', amount: '5000000', epoch_no: 651 }];
      },
      // History exists but does not end on self: stint boundary uncertain.
      async accountUpdateHistoryBatch() { return [hist('stake1odd', 'txOdd', 651, 1)]; },
      async txInfoCertsBatch() { return [{ tx_hash: 'txOdd', certificates: [cert('stake1odd', 'drep1elsewhere')] }]; },
    };
    const payload = await computeProvenance({ koios, db: db(), drepId: SELF, windowEpochs: 12, currentEpoch: 652, now: 1 });
    expect(payload.sources).toEqual([]);
    expect(payload.unresolved).toEqual({ count: 1, amount: '5000000' });
    expect(payload.base.count).toBe(0);
  });

  it('enforces the tx budget by degrading the smallest-stake candidates to notAnalyzed', async () => {
    // Tx counts are only known AFTER the (cheap) history stage, so the
    // budget gates the EXPENSIVE tx_info stage: history is fetched for all
    // three candidates, but with 2 delegation txs each and budget 4 only
    // the two largest get their txs resolved, the smallest degrades.
    const addrs = ['stake1big', 'stake1mid', 'stake1small'];
    const amounts: Record<string, string> = { stake1big: '9000000', stake1mid: '5000000', stake1small: '1000000' };
    const txRequests: string[] = [];
    const koios: ProvenanceKoios = {
      async drepDelegators(_d, _l = 1000, offset = 0) {
        return offset > 0 ? [] : addrs.map((a) => ({ stake_address: a, amount: amounts[a], epoch_no: 650 }));
      },
      async accountUpdateHistoryBatch(batch) {
        return batch.flatMap((a) => [hist(a, `${a}-t1`, 600, 1), hist(a, `${a}-t2`, 650, 2)]);
      },
      async txInfoCertsBatch(hashes) {
        txRequests.push(...hashes);
        return hashes.map((h) => ({
          tx_hash: h,
          certificates: [cert(h.split('-')[0], h.endsWith('t2') ? SELF : OTHER)],
        }));
      },
    };
    const payload = await computeProvenance({
      koios, db: db(), drepId: SELF, windowEpochs: 12, currentEpoch: 652, now: 1, txLookupBudget: 4,
    });
    expect(txRequests.sort()).toEqual(['stake1big-t1', 'stake1big-t2', 'stake1mid-t1', 'stake1mid-t2']);
    expect(payload.coverage.analyzedCandidateCount).toBe(2);
    expect(payload.coverage.totalCandidateCount).toBe(3);
    expect(payload.notAnalyzed).toEqual({ count: 1, amount: '1000000' });
    expect(payload.sources.reduce((acc, x) => acc + x.count, 0)).toBe(2);
  });

  it('pages drep_delegators until a short page and skips lookups with zero candidates', async () => {
    const calls: number[] = [];
    let historyCalled = false;
    const full = Array.from({ length: 1000 }, (_, i) =>
      ({ stake_address: `stake1p${i}`, amount: '1', epoch_no: 100 }));
    const koios: ProvenanceKoios = {
      async drepDelegators(_d, _l = 1000, offset = 0) { calls.push(offset); return offset === 0 ? full : []; },
      async accountUpdateHistoryBatch() { historyCalled = true; return []; },
      async txInfoCertsBatch() { return []; },
    };
    const payload = await computeProvenance({ koios, db: db(), drepId: SELF, windowEpochs: 12, currentEpoch: 652, now: 1 });
    expect(calls).toEqual([0, 1000]);
    expect(historyCalled).toBe(false);
    expect(payload.base.count).toBe(1000);
    expect(payload.sources).toEqual([]);
  });
});

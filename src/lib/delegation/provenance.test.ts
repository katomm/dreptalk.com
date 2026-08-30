import { describe, it, expect } from 'vitest';
import type { AccountUpdateHistoryRow, DrepDelegatorRow, TxCert } from '../koios/client';
import {
  aggregateSources, capCandidates, classifyCandidate, isCurrentPayloadVersion,
  normalizeTarget, prefilterDelegators, resolveEvents, type ResolvedEvent,
} from './provenance';

const SELF = 'drep1self';
const del = (addr: string, amount: string, epoch: number): DrepDelegatorRow =>
  ({ stake_address: addr, amount, epoch_no: epoch });
const ev = (target: string | null, epoch: number, slot: number): ResolvedEvent =>
  ({ txHash: `tx${slot}`, epoch, slot, target });

describe('normalizeTarget', () => {
  it('maps every Koios spelling of the special targets to the canonical set', () => {
    for (const raw of ['drep_always_abstain', 'always_abstain', 'abstain']) {
      expect(normalizeTarget(raw)).toBe('abstain');
    }
    for (const raw of ['drep_always_no_confidence', 'always_no_confidence', 'no_confidence']) {
      expect(normalizeTarget(raw)).toBe('no_confidence');
    }
    expect(normalizeTarget('drep1abc')).toBe('drep1abc');
    expect(normalizeTarget(null)).toBeNull();
    expect(normalizeTarget(42)).toBeNull();
  });
});

describe('prefilterDelegators', () => {
  it('epoch_no below the cutoff is proven base, at or above is only a candidate', () => {
    const rows = [del('old', '20', 639), del('edge', '10', 640), del('recent', '30', 652)];
    const { candidates, base } = prefilterDelegators(rows, 652, 12);
    expect(candidates.map((r) => r.stake_address)).toEqual(['edge', 'recent']);
    expect(base).toEqual({ count: 1, amount: '20' });
  });
});

describe('capCandidates', () => {
  it('keeps everything under the cap', () => {
    const { analyzed, notAnalyzed } = capCandidates([del('a', '10', 650)], 500);
    expect(analyzed).toHaveLength(1);
    expect(notAnalyzed).toBeNull();
  });
  it('keeps the top by amount numerically and sums the remainder', () => {
    const rows = [del('a', '9', 650), del('b', '100', 650), del('c', '30', 650)];
    const { analyzed, notAnalyzed } = capCandidates(rows, 2);
    expect(analyzed.map((r) => r.stake_address)).toEqual(['b', 'c']);
    expect(notAnalyzed).toEqual({ count: 1, amount: '9' });
  });
});

describe('resolveEvents', () => {
  it('filters to delegation_drep, sorts by (slot, tx), resolves targets from certs', () => {
    const hist: AccountUpdateHistoryRow[] = [
      { stake_address: 'a', action_type: 'delegation_drep', tx_hash: 't2', epoch_no: 650, absolute_slot: 20 },
      { stake_address: 'a', action_type: 'withdrawal', tx_hash: 'tw', epoch_no: 649, absolute_slot: 15 },
      { stake_address: 'a', action_type: 'delegation_drep', tx_hash: 't1', epoch_no: 640, absolute_slot: 10 },
    ];
    const certs = new Map<string, TxCert[]>([
      ['t1', [{ type: 'vote_delegation', info: { stake_address: 'a', drep_id: 'drep1x' } }]],
      ['t2', [{ type: 'vote_delegation', info: { stake_address: 'a', drep_id: 'drep_always_abstain' } }]],
    ]);
    const out = resolveEvents(hist, 'a', certs);
    expect(out.map((e) => e.target)).toEqual(['drep1x', 'abstain']);
    expect(out.map((e) => e.epoch)).toEqual([640, 650]);
  });

  it('takes the LAST matching vote_delegation cert within one tx and ignores foreign addresses', () => {
    const hist: AccountUpdateHistoryRow[] = [
      { stake_address: 'a', action_type: 'delegation_drep', tx_hash: 't1', epoch_no: 640, absolute_slot: 10 },
    ];
    const certs = new Map<string, TxCert[]>([
      ['t1', [
        { type: 'vote_delegation', info: { stake_address: 'a', drep_id: 'drep1first' } },
        { type: 'vote_delegation', info: { stake_address: 'OTHER', drep_id: 'drep1foreign' } },
        { type: 'vote_delegation', info: { stake_address: 'a', drep_id: 'drep1last' } },
      ]],
    ]);
    expect(resolveEvents(hist, 'a', certs)[0].target).toBe('drep1last');
  });

  it('a missing cert yields a null target, not an error', () => {
    const hist: AccountUpdateHistoryRow[] = [
      { stake_address: 'a', action_type: 'delegation_drep', tx_hash: 'tMISSING', epoch_no: 640, absolute_slot: 10 },
    ];
    expect(resolveEvents(hist, 'a', new Map())[0].target).toBeNull();
  });
});

describe('classifyCandidate', () => {
  const cutoff = 640;

  it('THE re-cert case: old stint with a recent same-target re-cert is base', () => {
    // A -> self @620, self re-cert @649. Stint began 620, before the cutoff.
    const events = [ev('drep1a', 610, 1), ev(SELF, 620, 2), ev(SELF, 649, 3)];
    expect(classifyCandidate(events, SELF, cutoff)).toEqual({ kind: 'base' });
  });

  it('a plain window arrival from another drep', () => {
    const events = [ev('drep1a', 620, 1), ev(SELF, 645, 2)];
    expect(classifyCandidate(events, SELF, cutoff)).toEqual({
      kind: 'arrival', source: { type: 'drep', drepId: 'drep1a' }, returning: false,
    });
  });

  it('self -> B -> C -> self: source is C, returning is true', () => {
    const events = [ev(SELF, 600, 1), ev('drep1b', 610, 2), ev('drep1c', 620, 3), ev(SELF, 645, 4)];
    expect(classifyCandidate(events, SELF, cutoff)).toEqual({
      kind: 'arrival', source: { type: 'drep', drepId: 'drep1c' }, returning: true,
    });
  });

  it('first-ever delegation straight to self is new, re-certs collapsed', () => {
    const events = [ev(SELF, 645, 1), ev(SELF, 646, 2)];
    expect(classifyCandidate(events, SELF, cutoff)).toEqual({
      kind: 'arrival', source: { type: 'new' }, returning: false,
    });
  });

  it('abstain and no_confidence sources keep their canonical types', () => {
    expect(classifyCandidate([ev('abstain', 630, 1), ev(SELF, 645, 2)], SELF, cutoff)).toEqual({
      kind: 'arrival', source: { type: 'abstain' }, returning: false,
    });
    expect(classifyCandidate([ev('no_confidence', 630, 1), ev(SELF, 645, 2)], SELF, cutoff)).toEqual({
      kind: 'arrival', source: { type: 'no_confidence' }, returning: false,
    });
  });

  it('unresolved: the stint boundary itself is uncertain', () => {
    // No usable history at all.
    expect(classifyCandidate([], SELF, cutoff)).toEqual({ kind: 'unresolved' });
    // History does not end on self (data skew for a current delegator).
    expect(classifyCandidate([ev('drep1a', 645, 1)], SELF, cutoff)).toEqual({ kind: 'unresolved' });
    // A pre-window null just before the self run: it could have been self,
    // which would push the stint start before the cutoff.
    expect(classifyCandidate([ev(null, 630, 1), ev(SELF, 645, 2)], SELF, cutoff)).toEqual({ kind: 'unresolved' });
    // Same shape with an earlier resolved self: still unresolved.
    expect(classifyCandidate([ev(SELF, 620, 1), ev(null, 630, 2), ev(SELF, 645, 3)], SELF, cutoff)).toEqual({ kind: 'unresolved' });
  });

  it('arrival with unknown source: the null predecessor is inside the window', () => {
    // Whether the null was self or not, the stint began at or after 642,
    // inside the window: it IS an arrival, only its source is unknown.
    expect(classifyCandidate([ev(null, 642, 1), ev(SELF, 645, 2)], SELF, cutoff)).toEqual({
      kind: 'arrival', source: { type: 'unknown' }, returning: false,
    });
  });

  it('unresolved: an in-window null could hide a self run starting before the cutoff', () => {
    // self@620, null@642, self@645. If the null was also self, all three
    // collapse into one stint starting at 620, before the cutoff: base, not
    // an in-window arrival. The run before the null (self@620) is before the
    // cutoff, so the in-window-null arrival shortcut is not safe here.
    expect(classifyCandidate([ev(SELF, 620, 1), ev(null, 642, 2), ev(SELF, 645, 3)], SELF, cutoff)).toEqual({
      kind: 'unresolved',
    });
  });

  it('arrival with unknown source still holds when the run before the null is self but in-window', () => {
    // self@641, null@642, self@645. The run before the null is self, but its
    // own epoch (641) is already inside the window, so even if the null
    // extends that same self stint, the stint start stays in-window.
    expect(classifyCandidate([ev(SELF, 641, 1), ev(null, 642, 2), ev(SELF, 645, 3)], SELF, cutoff)).toEqual({
      kind: 'arrival', source: { type: 'unknown' }, returning: false,
    });
  });

  it('payload version helper', () => {
    expect(isCurrentPayloadVersion('{"version":1}')).toBe(true);
    expect(isCurrentPayloadVersion('{"version":2}')).toBe(false);
    expect(isCurrentPayloadVersion('{}')).toBe(false);
    expect(isCurrentPayloadVersion('not json')).toBe(false);
  });
});

describe('aggregateSources', () => {
  it('groups by source, sums bigint amounts, counts returning, sorts by amount desc', () => {
    const out = aggregateSources([
      { row: del('a', '10', 650), source: { type: 'drep', drepId: 'drep1x' }, returning: true },
      { row: del('b', '30', 650), source: { type: 'drep', drepId: 'drep1x' }, returning: false },
      { row: del('c', '100', 650), source: { type: 'new' }, returning: false },
      { row: del('d', '5', 650), source: { type: 'abstain' }, returning: true },
    ]);
    expect(out).toEqual([
      { type: 'new', count: 1, amount: '100', returningCount: 0 },
      { type: 'drep', drepId: 'drep1x', count: 2, amount: '40', returningCount: 1 },
      { type: 'abstain', count: 1, amount: '5', returningCount: 1 },
    ]);
  });
});

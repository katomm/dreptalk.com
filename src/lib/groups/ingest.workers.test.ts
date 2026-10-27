/// <reference types="@cloudflare/workers-types" />
// The Koios ingest of the DRep groups store against a fake Koios. After every ingest run the engine
// runs with a fresh lease until it reports no more work, then the stored state is read.
import { env } from 'cloudflare:test';
import type { ChainInput, Credential, Recovery } from 'drep-groups';
import { decodeTransaction, hexToBytes, LIBRARY_VERSION, RETENTION_FLOOR, refKey, replay } from 'drep-groups';
import { describe, expect, it, vi } from 'vitest';
import { type Allowance, allowance, countingDb, UNLIMITED } from '../sync/queryBudget.js';
import {
  blockHash,
  type Chain,
  deepScriptBytes,
  ev,
  type FakeKoios,
  type FakeReg,
  type FakeTx,
  fakeKoios,
  forkHash,
  K,
  payloadValue,
  sig,
  sigScript,
  T,
  txCbor,
} from './__tests__/fixtures.js';
import { comparableD1 } from './__tests__/engineFixtures.js';
import { settle } from './__tests__/loadFixtures.js';
import { credBytes, hashBytes, hashFromCol, type Row } from './codec.js';
import { DEPTH, ENGINE_BUDGET, WITNESS_BACKOFF_BASE_MS } from './constants.js';
import { credentialForDrepId, drepIdForCredential } from './ids.js';
import { checkLibraryVersion, type IngestResult, ingestDrepGroups } from './ingest.js';
import { acquireLease, invocationOwner, releaseLease } from './store/lease.js';
import { openRecovery } from './store/recovery.js';
import { resetD1 } from '../test-d1-reset.workers.js';

const db = env.DB;
const HEAVY = 60_000;

const CONTROL = K(1);
const control = sigScript(CONTROL);
const M = K(0x50);
const credM: Credential = { kind: 'key', hash: M };
const drepM = drepIdForCredential(credM);
const GROUP = { txHash: T(1), index: 0 };
const FOUNDER_JOIN = { txHash: T(1), index: 1 };

const create: FakeTx = {
  hash: T(1),
  height: 100,
  index: 0,
  cbor: txCbor({ payload: payloadValue([ev.create(control.hash), ev.join(0, M)], [control.bytes]), requiredSigners: [CONTROL, M] }),
};
const regM: FakeReg = { drepId: drepM, action: 'registered', hash: T(0x40), height: 50, index: 0 };
const marker = (hash: string, height: number): FakeTx => ({ hash, height, index: 0, cbor: txCbor({ foreign: 1 }) });
const leaveTx = (hash: string, height: number): FakeTx => ({
  hash,
  height,
  index: 0,
  cbor: txCbor({ payload: payloadValue([ev.leave(FOUNDER_JOIN)]), requiredSigners: [M] }),
});

async function lease(): Promise<string> {
  const t = await acquireLease(db, invocationOwner());
  if (t === null) throw new Error('no lease');
  return t;
}

/** Runs the engine with a fresh lease until it has no more work. */
async function engine(): Promise<void> {
  const t = await lease();
  await settle(db, t, ENGINE_BUDGET);
  await releaseLease(db, t);
}

interface TickOptions {
  limits?: Partial<{ page: number; regPagesPerRun: number }>;
  now?: number;
  koios?: FakeKoios;
}

/** One ingest run under its own lease, then the engine. */
async function tick(chain: Chain, o: TickOptions = {}): Promise<IngestResult & { calls: string[] }> {
  const koios = o.koios ?? fakeKoios(chain);
  const t = await lease();
  let r: IngestResult;
  try {
    r = await ingestDrepGroups({ db, koios, lease: t, budget: UNLIMITED, now: o.now ?? 0, limits: o.limits });
  } finally {
    await releaseLease(db, t);
  }
  await engine();
  return { ...r, calls: koios.calls };
}

const all = async (sql: string, ...binds: unknown[]): Promise<Row[]> => (await db.prepare(sql).bind(...binds).all<Row>()).results ?? [];
const one = async (sql: string, ...binds: unknown[]): Promise<Row> => (await all(sql, ...binds))[0] as Row;
const count = async (sql: string, ...binds: unknown[]): Promise<number> => Number((await one(sql, ...binds)).n);
const meta = (): Promise<Row> => one('SELECT * FROM drep_group_meta WHERE id = 1');
const keyOf = (c: Credential): string => `${c.kind}:${c.hash}`;
const tracked = (c: Credential): Promise<Row | undefined> =>
  all('SELECT * FROM drep_group_tracked WHERE cred = ?', credBytes(keyOf(c))).then((r) => r[0]);
const groupRow = (): Promise<Row> => one('SELECT * FROM drep_groups WHERE group_tx = ? AND group_ix = 0', hashBytes(GROUP.txHash));
const instanceOf = (c: Credential): Promise<Row[]> =>
  all('SELECT * FROM drep_group_instances WHERE cred = ? ORDER BY joined_h', credBytes(keyOf(c)));
const ledgerOf = (c: Credential): Promise<Row[]> =>
  all('SELECT * FROM drep_group_ledger WHERE cred = ? ORDER BY block_height, tx_index, cert_index', credBytes(keyOf(c)));
const labelCount = (): Promise<number> => count('SELECT COUNT(*) AS n FROM drep_group_txs');
const ledgerCount = (): Promise<number> => count('SELECT COUNT(*) AS n FROM drep_group_ledger');
const regRow = (c: Credential, action: FakeReg['action'], hash: string, height: number): FakeReg => ({
  drepId: drepIdForCredential(c),
  action,
  hash,
  height,
  index: 0,
});

/** The library's replay of the chain at safe depth. */
function replayOf(chain: Chain): ReturnType<typeof replay> {
  const safe = chain.tip - DEPTH;
  const decoded = new Map(
    chain.txs.map((t) => [t.hash, decodeTransaction(hexToBytes(t.cbor), { txHash: t.hash, blockHeight: t.height, txIndex: t.index })]),
  );
  const inputs: ChainInput[] = [
    ...chain.txs.filter((t) => t.label !== false && t.height <= safe).map((t): ChainInput => ({ kind: 'tx', tx: decoded.get(t.hash)! })),
    ...chain.regs
      .filter((r) => r.height <= safe)
      .map(
        (r): ChainInput => ({
          kind: 'ledger',
          input: {
            kind: r.action === 'registered' ? 'reg' : 'unreg',
            credential: credentialForDrepId(r.drepId)!,
            txHash: r.hash,
            blockHeight: r.height,
            txIndex: r.index,
            certIndex: r.cert ?? 0,
            witnessScripts: decoded.get(r.hash)?.witnessScripts ?? [],
          },
        }),
      ),
  ];
  return replay(inputs);
}

/** Stored and replayed verdicts of GROUP as `ref valid reason` lines. */
async function verdictsVsReplay(chain: Chain): Promise<{ stored: string[]; replayed: string[] }> {
  const line = (ref: string, valid: boolean, reason: string | null) => `${ref} ${valid} ${reason}`;
  const stored = (await all('SELECT * FROM drep_group_verdicts WHERE group_tx = ? AND group_ix = 0', hashBytes(GROUP.txHash)))
    .map((r) => line(`${hashFromCol(r.tx_hash)}#${Number(r.idx)}`, Number(r.valid) === 1, r.reason === null ? null : String(r.reason)))
    .sort();
  const replayed = replayOf(chain)
    .verdicts.filter((v) => v.group !== null && refKey(v.group) === refKey(GROUP))
    .map((v) => line(refKey(v.ref), v.valid, v.reason))
    .sort();
  return { stored, replayed };
}

describe('ingestDrepGroups: events and registrations', () => {
  it('ingests a create with a founder join', async () => {
    const r = await tick({ tip: 200, txs: [create], regs: [regM] });
    expect(r).toMatchObject({ newTxs: 1, markers: 0, tracked: 1, probing: false, recovery: null });
    expect(await groupRow()).toMatchObject({ status: 'active', members: 1 });
    expect((await instanceOf(credM)).map((i) => i.counted_as)).toEqual(['open']);
  });

  it('waits for the depth', async () => {
    const r = await tick({ tip: 100 + DEPTH - 1, txs: [create], regs: [regM] });
    expect(r.newTxs).toBe(0);
    expect(await labelCount()).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_tracked')).toBe(0);
  });

  it('tracks every join member, signed or not', async () => {
    const chain: Chain = { tip: 200, txs: [create], regs: [regM] };
    await tick(chain);
    const stranger: Credential = { kind: 'key', hash: K(0x70) };
    chain.tip = 300;
    chain.txs.push({ hash: T(8), height: 250, index: 0, cbor: txCbor({ payload: payloadValue([ev.join(GROUP, stranger.hash)]) }) });
    const r = await tick(chain);
    expect(r.tracked).toBe(1);
    expect(await tracked(stranger)).toMatchObject({ known: 0, complete: 1 });
    expect(r.calls.filter((c) => c.startsWith('known:'))).toEqual(['known:1']);
    const { stored, replayed } = await verdictsVsReplay(chain);
    expect(stored).toEqual(replayed);
    expect(stored).toContain(`${T(8)}#0 false member key not in required_signers`);
  });

  it('catches a retirement and re-registration between runs', async () => {
    const chain: Chain = { tip: 200, txs: [create], regs: [regM] };
    await tick(chain);
    chain.tip = 400;
    chain.regs.push(regRow(credM, 'deregistered', T(0x41), 300), regRow(credM, 'registered', T(0x42), 305));
    const r = await tick(chain);
    expect(r.newLedgerRows).toBe(2);
    expect(await tracked(credM)).toMatchObject({ retiring: 1, retired_at_h: 300 });
    expect(hashFromCol((await tracked(credM))?.retired_at_tx)).toBe(T(0x41));
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'retire'")).toBe(1);
  });

  it('holds back a retirement that is not deep enough yet', async () => {
    const chain: Chain = { tip: 200, txs: [create], regs: [regM] };
    await tick(chain);
    chain.regs.push(regRow(credM, 'deregistered', T(0x41), 195));
    await tick(chain);
    expect(await tracked(credM)).toMatchObject({ retiring: 0, retired_at_h: null });
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'retire'")).toBe(0);
    expect(await ledgerOf(credM)).toHaveLength(1);
    chain.tip = 300;
    await tick(chain);
    expect(await tracked(credM)).toMatchObject({ retiring: 1, retired_at_h: 195 });
  });

  it('continues an incremental read beyond the page cap', async () => {
    const chain: Chain = { tip: 200, txs: [create], regs: [regM] };
    await tick(chain);
    // Seven unreg and reg rows of M inside the overlap window, read two per page and two pages per run.
    for (let i = 0; i < 7; i++) chain.regs.push(regRow(credM, i % 2 === 0 ? 'deregistered' : 'registered', T(0x50 + i), 181 + i));
    const limits = { page: 2, regPagesPerRun: 2 };
    const first = await tick(chain, { limits });
    expect(first.backlog).toBe(true);
    expect((await meta()).reg_offset).toBe(4);
    await tick(chain, { limits });
    expect((await meta()).reg_offset).toBe(8);
    const last = await tick(chain, { limits });
    expect(last.backlog).toBe(false);
    expect(await meta()).toMatchObject({ reg_offset: 0, reg_time: (200 - DEPTH) * 20, R: 200 - DEPTH });
    expect(await ledgerOf(credM)).toHaveLength(8);
    expect(await tracked(credM)).toMatchObject({ retiring: 1 });
  });

  it('pages a history that does not fit the batched read on its own', async () => {
    // M retires and registers again three times, seven rows that a page of 2 does not hold.
    const cycles = Array.from({ length: 6 }, (_, i) => regRow(credM, i % 2 === 0 ? 'deregistered' : 'registered', T(0x70 + i), 60 + i));
    const chain: Chain = { tip: 300, txs: [create], regs: [regM, ...cycles] };
    const limits = { page: 2 };
    const first = await tick(chain, { limits });
    expect(first.calls.filter((c) => c.startsWith('regsFor'))).toEqual(['regsForMany:1:0', 'regsFor:0']);
    expect(await tracked(credM)).toMatchObject({ solo: 1, history_done: 0, history_offset: 2 });
    expect(await instanceOf(credM)).toEqual([]);
    const offsets: string[] = [];
    for (let i = 0; i < 3; i++) offsets.push(...(await tick(chain, { limits })).calls.filter((c) => c.startsWith('regsFor')));
    expect(offsets).toEqual(['regsFor:2', 'regsFor:4', 'regsFor:6']);
    expect(await tracked(credM)).toMatchObject({ solo: 1, history_done: 1, history_offset: 0 });
    expect(await ledgerOf(credM)).toHaveLength(7);
    expect((await instanceOf(credM)).map((i) => i.counted_as)).toEqual(['open']);
  });

  it('a known 0 credential that registers later becomes known and waits for its history', async () => {
    const X: Credential = { kind: 'key', hash: K(0x77) };
    const joinX = (hash: string, height: number): FakeTx => ({
      hash,
      height,
      index: 0,
      cbor: txCbor({ payload: payloadValue([ev.join(GROUP, X.hash)]), requiredSigners: [X.hash] }),
    });
    const chain: Chain = { tip: 200, txs: [create, joinX(T(2), 110)], regs: [regM] };
    await tick(chain);
    // The gate does not know X: setKnown stores known 0, the credential is complete with no history.
    expect(await tracked(X)).toMatchObject({ known: 0, history_done: 0, complete: 1 });
    chain.tip = 400;
    chain.regs.push(regRow(X, 'registered', T(0x60), 300));
    chain.txs.push(joinX(T(3), 310));
    const second = await tick(chain);
    // The reader stores the registration, knownFromLedger makes X known with its history still to read.
    expect(await ledgerOf(X)).toHaveLength(1);
    expect(await tracked(X)).toMatchObject({ known: 1, history_done: 0, complete: 0 });
    expect(second.calls.some((c) => c.startsWith('regsFor'))).toBe(false);
    expect((await instanceOf(X)).filter((i) => i.counted_as === 'open')).toEqual([]);
    const third = await tick(chain);
    expect(third.calls.filter((c) => c.startsWith('regsFor'))).toEqual(['regsForMany:1:0']);
    expect(await tracked(X)).toMatchObject({ known: 1, history_done: 1, complete: 1 });
    expect((await instanceOf(X)).map((i) => i.counted_as)).toEqual(['open']);
  });

  it('reads a script DRep registration and its join in one transaction', async () => {
    const script = sigScript(K(9));
    const S: Credential = { kind: 'script', hash: script.hash };
    const both: FakeTx = {
      hash: T(5),
      height: 120,
      index: 0,
      cbor: txCbor({ payload: payloadValue([ev.join(GROUP, S.hash, 'script')]), requiredSigners: [K(9)], witnessScripts: [sig(K(9))] }),
    };
    const r = await tick({ tip: 300, txs: [create, both], regs: [regM, regRow(S, 'registered', T(5), 120)] });
    expect(r.witnessChecks).toBe(1);
    const [row] = await ledgerOf(S);
    expect(row).toMatchObject({ witness_state: 'checked', witness_attempts: 0, witness_retry_at: 0 });
    expect(new Uint8Array(row.witness as ArrayBuffer)).toEqual(script.bytes);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_member_scripts WHERE cred = ?', credBytes(keyOf(S)))).toBe(1);
    expect((await instanceOf(S)).map((i) => i.counted_as)).toEqual(['open']);
  });

  it('backs off a witness fetch that keeps failing', async () => {
    const scripts = [0x91, 0x92, 0x93, 0x94].map((k) => ({ key: K(k), ...sigScript(K(k)) }));
    const creds = scripts.map((s): Credential => ({ kind: 'script', hash: s.hash }));
    // Each script DRep registers in a tx of its own that carries its witness, then joins.
    const regTx = (i: number, height: number): FakeTx => ({
      hash: T(0x900 + i),
      height,
      index: 0,
      label: false,
      cbor: txCbor({ requiredSigners: [scripts[i].key], witnessScripts: [sig(scripts[i].key)] }),
    });
    const joinTx = (i: number, height: number): FakeTx => ({
      hash: T(0x950 + i),
      height,
      index: 0,
      cbor: txCbor({ payload: payloadValue([ev.join(GROUP, scripts[i].hash, 'script')]), requiredSigners: [scripts[i].key] }),
    });
    const add = (chain: Chain, i: number, height: number) => {
      chain.txs.push(regTx(i, height), joinTx(i, height + 1));
      chain.regs.push(regRow(creds[i], 'registered', T(0x900 + i), height));
    };
    const chain: Chain = { tip: 300, txs: [create], regs: [regM], leaveOut: new Set([T(0x900)]) };
    add(chain, 0, 120);
    add(chain, 1, 130);
    const retries: number[] = [];
    for (const [run, now] of [0, 1_000_000, 3_000_000].entries()) {
      const r = await tick(chain, { now });
      const [failing] = await ledgerOf(creds[0]);
      expect(failing).toMatchObject({ witness_state: 'pending', witness_attempts: run + 1 });
      retries.push(Number(failing.witness_retry_at));
      expect(await tracked(creds[0])).toMatchObject({ pending_witness: 1, complete: 0 });
      // The later row of another credential is checked in the same run.
      const [later] = await ledgerOf(creds[run + 1]);
      expect(later).toMatchObject({ witness_state: 'checked' });
      expect(r.witnessChecks).toBe(2);
      chain.tip += 100;
      if (run < 2) add(chain, run + 2, 300 + 100 * run);
    }
    expect(retries).toEqual([WITNESS_BACKOFF_BASE_MS, 1_000_000 + 2 * WITNESS_BACKOFF_BASE_MS, 3_000_000 + 4 * WITNESS_BACKOFF_BASE_MS]);
    expect(await instanceOf(creds[0])).toEqual([]);
  });
});

describe('ingestDrepGroups: late inputs and rollbacks', () => {
  it('a late reg row below applied-through opens a truncation and the result equals replay', async () => {
    const chain: Chain = { tip: 300, txs: [create, leaveTx(T(3), 150)], regs: [regM] };
    await tick(chain);
    expect(await groupRow()).toMatchObject({ members: 0 });
    // Koios delivers an older unreg of M only now, below what M has applied.
    chain.regs.push(regRow(credM, 'deregistered', T(0x41), 120));
    const t = await lease();
    const r = await ingestDrepGroups({ db, koios: fakeKoios(chain), lease: t, budget: UNLIMITED, now: 0 });
    await releaseLease(db, t);
    expect(r.recovery).toMatchObject({ kind: 'truncate' });
    await engine();
    for (let i = 0; i < 2; i++) await tick(chain);
    const { stored, replayed } = await verdictsVsReplay(chain);
    expect(stored).toEqual(replayed);
    expect(await tracked(credM)).toMatchObject({ retiring: 1, retired_at_h: 120 });
  });

  it('an unreg above the cut comes back through the reader', async () => {
    const chain: Chain = { tip: 300, txs: [create, marker(T(2), 150)], regs: [regM, regRow(credM, 'deregistered', T(0x41), 155)] };
    await tick(chain);
    expect(await tracked(credM)).toMatchObject({ retiring: 1 });
    // Every block above 150 changed: the probes find 150 and cut above it.
    chain.hashAt = (h) => (h > 150 ? forkHash(h) : blockHash(h));
    const t = await lease();
    const r = await ingestDrepGroups({ db, koios: fakeKoios(chain), lease: t, budget: UNLIMITED, now: 0 });
    await releaseLease(db, t);
    expect(r.recovery).toEqual({ kind: 'truncate', above: 150 });
    await engine();
    expect(await ledgerOf(credM)).toHaveLength(1);
    expect((await meta()).reg_time).toBe(150 * 20);
    const again = await tick(chain);
    expect(again.calls).toContain(`regs:${Math.max(0, 150 * 20 - 3600)}:0`);
    const rows = await ledgerOf(credM);
    expect(rows.map((x) => x.kind)).toEqual(['reg', 'unreg']);
    expect(hashFromCol(rows[1].block_hash)).toBe(forkHash(155));
    expect(await tracked(credM)).toMatchObject({ retiring: 1, retired_at_h: 155 });
  });

  it('rolls back to the common ancestor when a stored block hash changed', async () => {
    const chain: Chain = { tip: 300, txs: [create, leaveTx(T(3), 150)], regs: [regM] };
    await tick(chain);
    expect(await groupRow()).toMatchObject({ members: 0 });
    // The chain forked at 150: the leave is gone.
    chain.txs = [create];
    chain.hashAt = (h) => (h >= 150 ? forkHash(h) : blockHash(h));
    const r = await tick(chain);
    expect(r.recovery).toEqual({ kind: 'truncate', above: 100 });
    expect(r.newTxs).toBe(0);
    await tick(chain);
    // The leave is undone, the counters and caches follow with the recompute job.
    expect((await instanceOf(credM)).map((i) => [i.closed_h, i.close_reason])).toEqual([[null, null]]);
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'recompute'")).toBe(1);
    expect(await meta()).toMatchObject({ L: 290, probe_active: 0 });
    expect((await meta()).L_hash).toBe(forkHash(290));
  });

  it('fails when a deeper probe gets no block', async () => {
    const chain: Chain = { tip: 300, txs: [create, leaveTx(T(3), 150)], regs: [regM] };
    await tick(chain);
    chain.hashAt = (h) => (h >= 150 ? forkHash(h) : h === 100 ? null : blockHash(h));
    await expect(tick(chain)).rejects.toThrow(/rollback probe at 100/);
    expect(await meta()).toMatchObject({ probe_active: 0, rec_first_kind: null });
  });

  it('stops discovery while a probe search runs across ticks', async () => {
    const txs = Array.from({ length: 51 }, (_, i) => marker(T(0x200 + i), 200 + i));
    const chain: Chain = { tip: 270, txs, regs: [] };
    await tick(chain);
    expect(await labelCount()).toBe(51);
    // The chain forked above 205, 45 stored blocks lie between the top and the ancestor.
    chain.hashAt = (h) => (h > 205 ? forkHash(h) : blockHash(h));
    chain.tip = 290;
    chain.txs = [...txs.filter((t) => t.height <= 205), ...Array.from({ length: 5 }, (_, i) => marker(T(0x300 + i), 261 + i))];
    for (const below of [232, 212]) {
      const r = await tick(chain);
      expect(r).toMatchObject({ probing: true, recovery: null, newTxs: 0, newLedgerRows: 0 });
      expect(r.calls.filter((c) => c.startsWith('block:')).length).toBe(1 + 20);
      expect(r.calls.some((c) => c.startsWith('label:') || c.startsWith('known:') || c.startsWith('regs'))).toBe(false);
      expect(await labelCount()).toBe(51);
      expect(await meta()).toMatchObject({ probe_active: 1, probe_below: below });
    }
    const third = await tick(chain);
    expect(third).toMatchObject({ probing: false, recovery: { kind: 'truncate', above: 205 } });
    expect(await meta()).toMatchObject({ probe_active: 0, probe_below: null, rec_first_kind: null, L: 205 });
    await tick(chain);
    expect(await labelCount()).toBe(6 + 5);
  });

  it('walks probes across runs and opens a fork below the retention floor', { timeout: HEAVY }, async () => {
    const txs = [marker(T(0x100), 100), ...Array.from({ length: 30 }, (_, i) => marker(T(0x400 + i), 3000 + i))];
    const chain: Chain = { tip: 3100, txs, regs: [] };
    await tick(chain);
    expect((await meta()).L).toBe(3090);
    expect(3090 - RETENTION_FLOOR).toBeGreaterThan(100);
    chain.hashAt = (h) => forkHash(h);
    const first = await tick(chain);
    expect(first).toMatchObject({ probing: true, recovery: null });
    const second = await tick(chain);
    expect(second.recovery).toEqual({ kind: 'fork' });
    expect(second.calls).not.toContain('block:100');
    expect(await labelCount()).toBe(0);
    expect(await meta()).toMatchObject({ L: -1, probe_active: 0, probe_below: null });
  });

  it('skips the ingest while a recovery is open', async () => {
    const chain: Chain = { tip: 200, txs: [create], regs: [regM] };
    await tick(chain);
    const t = await lease();
    await openRecovery(db, { kind: 'truncate', above: 100 }, t);
    const koios = fakeKoios(chain);
    const r = await ingestDrepGroups({ db, koios, lease: t, budget: UNLIMITED, now: 0 });
    expect(r.recovery).toEqual({ kind: 'truncate', above: 100 } satisfies Recovery);
    expect(koios.calls).toEqual([]);
  });
});

describe('ingestDrepGroups: failures and spam', () => {
  it('fails the run when Koios leaves out a requested transaction', async () => {
    const chain: Chain = { tip: 200, txs: [create], regs: [regM], leaveOut: new Set([T(1)]) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(tick(chain)).rejects.toThrow(/tx_cbor/);
    // One line names the missing tx before the run fails.
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([`[drep-groups] koios tx_cbor left out tx ${T(1)}`]);
    log.mockRestore();
    expect(await labelCount()).toBe(0);
    expect(await meta()).toMatchObject({ L: -1, R: null });
  });

  it('writes nothing when drep_info fails', async () => {
    const koios = fakeKoios({ tip: 200, txs: [create], regs: [regM] });
    koios.knownDrepIds = async () => {
      throw new Error('koios 503');
    };
    await expect(tick({ tip: 200, txs: [], regs: [] }, { koios })).rejects.toThrow('koios 503');
    expect(await tracked(credM)).toMatchObject({ known: null });
  });

  it('stores a foreign payload as a marker and survives hostile refs', async () => {
    const foreign = { hash: T(2), height: 101, index: 0, cbor: txCbor({ foreign: 'not a payload' }) };
    const over = { hash: T(3), height: 102, index: 0, cbor: txCbor({ payload: payloadValue(Array.from({ length: 65 }, () => ev.leave(FOUNDER_JOIN))) }) };
    const hostile = {
      hash: T(6),
      height: 130,
      index: 0,
      cbor: txCbor({
        payload: payloadValue([ev.leave({ txHash: T(1), index: 70_000 })], [deepScriptBytes(5000)]),
        requiredSigners: [M],
      }),
    };
    const r = await tick({ tip: 300, txs: [create, foreign, over, hostile], regs: [regM] });
    expect(r).toMatchObject({ newTxs: 4, markers: 2 });
    const rows = await all('SELECT tx_hash, marker FROM drep_group_txs ORDER BY block_height');
    expect(rows.map((x) => [hashFromCol(x.tx_hash), x.marker])).toEqual([
      [T(1), 0],
      [T(2), 1],
      [T(3), 1],
      [T(6), 0],
    ]);
    expect(await groupRow()).toMatchObject({ members: 1 });
    // The engine ran through every stored tx.
    expect(await meta()).toMatchObject({ G_h: 290 });
  });

  it('works through a large backlog in capped runs', { timeout: HEAVY }, async () => {
    const many = Array.from({ length: 1001 }, (_, i) => marker(T(i + 10), 100 + i));
    const chain: Chain = { tip: 5000, txs: many, regs: [] };
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await tick(chain);
      sizes.push(r.newTxs);
      expect(r.calls.filter((c) => c.startsWith('label:')).length).toBeLessThanOrEqual(2);
      expect(r.backlog).toBe(i < 2);
    }
    expect(sizes).toEqual([500, 500, 1]);
    expect((await meta()).L).toBe(5000 - DEPTH);
  });

  it('rebuilds once when the library version changed', { timeout: HEAVY }, async () => {
    const chain: Chain = { tip: 200, txs: [create, marker(T(2), 101)], regs: [regM] };
    await tick(chain);
    await db.prepare("UPDATE drep_group_meta SET lib_version = '0.0.0' WHERE id = 1").run();
    const t = await lease();
    // A batch that fails after the version write leaves the version and the slots unchanged.
    const failing = new Proxy(db, {
      get(target, p) {
        if (p === 'batch') return (stmts: D1PreparedStatement[]) => target.batch([...stmts, target.prepare('SELECT * FROM no_such_table')]);
        const v = Reflect.get(target, p);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await expect(checkLibraryVersion(failing, t)).rejects.toThrow();
    expect(await meta()).toMatchObject({ lib_version: '0.0.0', rec_first_kind: null });
    expect(await checkLibraryVersion(db, t)).toBe(true);
    expect(await meta()).toMatchObject({ lib_version: LIBRARY_VERSION, rec_first_kind: 'rebuild' });
    await releaseLease(db, t);
    await engine();
    expect(await one('SELECT refetch FROM drep_group_txs WHERE tx_hash = ?', hashBytes(T(2)))).toEqual({ refetch: 1 });
    const r = await tick(chain);
    expect(r.refetched).toBe(1);
    expect(await one('SELECT refetch, marker FROM drep_group_txs WHERE tx_hash = ?', hashBytes(T(2)))).toEqual({ refetch: 0, marker: 1 });
    expect(await meta()).toMatchObject({ rebuilding: 0, rec_first_kind: null });
    expect(await groupRow()).toMatchObject({ members: 1 });
    const t2 = await lease();
    expect(await checkLibraryVersion(db, t2)).toBe(false);
    expect((await meta()).rec_first_kind).toBe(null);
  });

  it('gives up a marker refetch after its attempts and keeps the marker', async () => {
    const chain: Chain = { tip: 200, txs: [create, marker(T(2), 101)], regs: [regM] };
    await tick(chain);
    await db.prepare("UPDATE drep_group_meta SET lib_version = '0.0.0' WHERE id = 1").run();
    const t = await lease();
    await checkLibraryVersion(db, t);
    await releaseLease(db, t);
    await engine();
    // A failing call counts no attempt.
    const down = fakeKoios(chain);
    down.txCborBatch = async () => {
      throw new Error('koios 503');
    };
    await expect(tick(chain, { koios: down })).rejects.toThrow('koios 503');
    expect(await one('SELECT refetch, refetch_attempts FROM drep_group_txs WHERE tx_hash = ?', hashBytes(T(2)))).toEqual({
      refetch: 1,
      refetch_attempts: 0,
    });
    chain.leaveOut = new Set([T(2)]);
    for (let i = 0; i < 5; i++) expect((await tick(chain)).refetched).toBe(0);
    expect(await one('SELECT refetch, marker FROM drep_group_txs WHERE tx_hash = ?', hashBytes(T(2)))).toEqual({ refetch: 0, marker: 1 });
    expect(await meta()).toMatchObject({ rebuilding: 0 });
    expect(await ledgerCount()).toBe(1);
  });
});

describe('ingestDrepGroups: a finite allowance', () => {
  // M has a long history, so storing it costs more queries than the probes and the gate.
  const history = Array.from({ length: 300 }, (_, i) => ({ ...regRow(credM, i % 2 === 0 ? 'deregistered' : 'registered', T(0x5000 + i), 60), index: i }));
  const chain = (): Chain => ({ tip: 200, txs: [create], regs: [regM, ...history, { ...regM, hash: T(0x6000), height: 61 }] });
  type Check = { spent: number; cost: number; calls: number };

  /** One ingest under a finite allowance through the production query meter, every covers call logged, then the engine. */
  async function finite(c: Chain, limit: number, log: Check[] = []): Promise<IngestResult & { calls: string[] }> {
    const koios = fakeKoios(c);
    const { db: counted, meter } = countingDb(db);
    const inner = allowance(meter, limit);
    const budget: Allowance = {
      ...inner,
      covers: (cost) => {
        log.push({ spent: inner.spent(), cost, calls: koios.calls.length });
        return inner.covers(cost);
      },
    };
    const t = await lease();
    const r = await ingestDrepGroups({ db: counted, koios, lease: t, budget, now: 0 });
    await releaseLease(db, t);
    await engine();
    return { ...r, calls: koios.calls };
  }

  it('starves the history unit without writing it and catches up in the next run', async () => {
    // A run with room to spare measures the unit of the batched history read and the state it leaves.
    const log: Check[] = [];
    const full = await finite(chain(), 10_000, log);
    expect(full.starved).toEqual([]);
    // The check of the history unit is the first one after its Koios read.
    const read = full.calls.findIndex((x) => x.startsWith('regsForMany'));
    const unit = log.find((x) => x.calls > read) as Check;
    expect(unit.cost).toBeGreaterThan(40);
    const budget = unit.spent + unit.cost - 1;
    const snapshot = await comparableD1(db);

    // The same chain from an empty store, one query short of the unit.
    await resetD1();
    const c = chain();
    const r = await finite(c, budget);
    expect(r.starved).toContain('histories');
    expect(r.newTxs).toBe(1);
    // Nothing of the unit is stored, its cursors did not move.
    expect(await ledgerOf(credM)).toEqual([]);
    expect(await tracked(credM)).toMatchObject({ known: 1, history_done: 0, solo: 0, history_offset: 0 });
    expect(await meta()).toMatchObject({ reg_time: (200 - DEPTH) * 20, reg_offset: 0, R: 200 - DEPTH });
    const next = await finite(c, 10_000);
    expect(next.starved).toEqual([]);
    expect(await comparableD1(db)).toEqual(snapshot);
  });
});

/// <reference types="@cloudflare/workers-types" />
// The DRep groups sync phase: lease, query allowance and the order of its steps, against a fake Koios.
import { env } from 'cloudflare:test';
import type { Credential } from 'drep-groups';
import { hexToBytes, LIBRARY_VERSION } from 'drep-groups';
import { describe, expect, it, vi } from 'vitest';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { profilesToFetch } from '../db/drepGroups.js';
import { allowance, countingDb, type QueryMeter } from '../sync/queryBudget.js';
import { type Chain, ev, type FakeKoios, type FakeReg, type FakeTx, fakeKoios, K, payloadValue, sigScript, T, txCbor } from './__tests__/fixtures.js';
import { hashBytes, type Row } from './codec.js';
import {
  ADMIN_RESERVE_QUERIES,
  GOVERNANCE_QUERY_BUDGET,
  GROUPS_QUERY_SHARE,
  MAX_ENGINE_RUNS_PER_TICK,
  PROFILE_QUERIES_PER_ITEM,
  PROFILE_SELECT_QUERIES,
  RELEASE_RESERVE_QUERIES,
  RUN_MAX_QUERIES,
  WEBSITE_QUERIES_PER_ITEM,
  WEBSITE_SELECT_QUERIES,
} from './constants.js';
import { drepIdForCredential, groupIdString } from './ids.js';
import { maintainProfiles, type PhaseReport, runDrepGroupsPhase } from './phase.js';
import { acquireLease, invocationOwner } from './store/lease.js';
import { Q } from './store/queries.js';

const real = env.DB;

const CONTROL = K(1);
const control = sigScript(CONTROL);
const M = K(0x50);
const credM: Credential = { kind: 'key', hash: M };
const regM: FakeReg = { drepId: drepIdForCredential(credM), action: 'registered', hash: T(0x40), height: 50, index: 0 };
const create: FakeTx = {
  hash: T(1),
  height: 100,
  index: 0,
  cbor: txCbor({ payload: payloadValue([ev.create(control.hash), ev.join(0, M)], [control.bytes]), requiredSigners: [CONTROL, M] }),
};
const founded = (): Chain => ({ tip: 200, txs: [create], regs: [regM] });
/** `n` groups without members, one create per block. */
/** `n` groups, one create with a founder join of its own registered member per block. */
function foundings(n: number): Chain {
  const member = (i: number): string => K(0x2000 + i);
  return {
    tip: 100 + n + 20,
    txs: Array.from({ length: n }, (_, i) => ({
      hash: T(0x3000 + i),
      height: 100 + i,
      index: 0,
      cbor: txCbor({
        payload: payloadValue([ev.create(control.hash), ev.join(0, member(i))], [control.bytes]),
        requiredSigners: [CONTROL, member(i)],
      }),
    })),
    regs: Array.from({ length: n }, (_, i) => ({
      drepId: drepIdForCredential({ kind: 'key', hash: member(i) }),
      action: 'registered' as const,
      hash: T(0x5000 + i),
      height: 50,
      index: i,
    })),
  };
}
const creates = (n: number): Chain => ({
  tip: 100 + n + 20,
  txs: Array.from({ length: n }, (_, i) => ({
    hash: T(0x1000 + i),
    height: 100 + i,
    index: 0,
    cbor: txCbor({ payload: payloadValue([ev.create(control.hash)], [control.bytes]), requiredSigners: [CONTROL] }),
  })),
  regs: [],
});

const all = async (sql: string, ...binds: unknown[]): Promise<Row[]> => (await real.prepare(sql).bind(...binds).all<Row>()).results ?? [];
const one = async (sql: string, ...binds: unknown[]): Promise<Row> => (await all(sql, ...binds))[0] as Row;
const count = async (sql: string, ...binds: unknown[]): Promise<number> => Number((await one(sql, ...binds)).n);
const meta = (): Promise<Row> => one('SELECT * FROM drep_group_meta WHERE id = 1');
const leaseRow = (): Promise<Row | undefined> => all('SELECT * FROM drep_group_lease WHERE id = 1').then((r) => r[0]);

/** A counted database whose meter reads as if the earlier phases left `remaining` queries of the invocation. */
function budgeted(remaining: number, db: D1Database = real): { db: D1Database; meter: QueryMeter; spent: () => number } {
  const c = countingDb(db);
  const offset = GOVERNANCE_QUERY_BUDGET - remaining;
  return { db: c.db, meter: { used: () => c.meter.used() + offset }, spent: () => c.meter.used() };
}

interface RunOptions {
  chain?: Chain;
  koios?: FakeKoios;
  remaining?: number;
  fetchImpl?: typeof fetch;
  db?: D1Database;
  now?: number;
}

async function run(o: RunOptions = {}): Promise<PhaseReport & { spent: number }> {
  const b = budgeted(o.remaining ?? GOVERNANCE_QUERY_BUDGET, o.db);
  const r = await runDrepGroupsPhase({
    db: b.db,
    koios: o.koios ?? fakeKoios(o.chain ?? { tip: 200, txs: [], regs: [] }),
    meter: b.meter,
    gateway: null,
    network: 'preprod',
    now: o.now ?? 1_000,
    fetchImpl: o.fetchImpl ?? (vi.fn() as unknown as typeof fetch),
  });
  return { ...r, spent: b.spent() };
}

// A profile document naming a website, and the website's list naming the group.
const docBytes = new TextEncoder().encode(JSON.stringify({ '@context': {}, hashAlgorithm: 'blake2b-256', body: { name: 'Council', website: 'https://council.test' } }));
const docHash = bytesToHex(blake2b256(docBytes));
const PROFILE_URL = 'https://host.test/g.json';
const seedTx = (n: number): string => (0x9000 + n).toString(16).padStart(64, '0');

/** A listed group with an anchor and a due profile. */
async function seedListed(n: number): Promise<void> {
  const tx = hashBytes(seedTx(n));
  await real
    .prepare(
      `INSERT INTO drep_groups (group_tx, group_ix, cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, profile_url, profile_hash, seq,
        status, created_h, created_ti, created_ph, created_ix, created_tx, members)
       VALUES (?1, 0, 1, 0, 2, 0, ?1, 'open', X'aa', ?2, ?3, '0', 'active', 1, 0, 2, 0, ?1, 2)`,
    )
    .bind(tx, PROFILE_URL, hashBytes(docHash))
    .run();
  await real.prepare("INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at) VALUES ('profile', ?, 0, 0)").bind(tx).run();
}

function siteFetch(): typeof fetch {
  return vi.fn(async (url: string | URL | Request) =>
    String(url).includes('.well-known')
      ? new Response(JSON.stringify({ preprod: [groupIdString({ txHash: seedTx(1), index: 0 })] }), { status: 200 })
      : new Response(docBytes, { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

/** A tracked group transaction of DRepTalk, its tx hash as body hash. */
async function tracked(id: string, body: string, events: number): Promise<void> {
  await real
    .prepare(
      `INSERT INTO pending_multisig_tx (id, drep_id, action, action_params, unsigned_tx_cbor, body_hash, native_script, status,
         created_by, created_at, expires_at, subject_kind, event_count, invalid_hereafter, control_slot)
       VALUES (?, 'g1', 'group_update', '{}', '00', ?, '{}', 'submitted', 'u1', 1, 2, 'group', ?, 1000000, 0)`,
    )
    .bind(id, body, events)
    .run();
}
const resolution = (id: string): Promise<Row> =>
  one('SELECT resolution, resolved_h, never_included_at FROM pending_multisig_tx WHERE id = ?', id);
const groupRef = { txHash: T(1), index: 0 };
const refCbor = (r: { txHash: string; index: number }) => [hexToBytes(r.txHash), r.index];
const controlTx = (hash: string, height: number, events: Parameters<typeof payloadValue>[0], scripts: Uint8Array[] = []): FakeTx => ({
  hash,
  height,
  index: 0,
  cbor: txCbor({ payload: payloadValue(events, scripts), requiredSigners: [CONTROL] }),
});

const dueCount = (kind: string, now: number): Promise<number> =>
  count('SELECT COUNT(*) AS n FROM drep_group_due WHERE kind = ? AND due_at <= ?', kind, now);

describe('runDrepGroupsPhase', () => {
  it('ingests and commits a create with a founder join in the same tick', async () => {
    const r = await run({ chain: founded() });
    expect(r.lease).toBe('held');
    expect(r.runs).toBeGreaterThanOrEqual(1);
    expect(r.ingest).toMatchObject({ newTxs: 1, tracked: 1 });
    expect(await one('SELECT status, members FROM drep_groups WHERE group_tx = ? AND group_ix = 0', hashBytes(T(1)))).toMatchObject({
      status: 'active',
      members: 1,
    });
    expect((await leaseRow())?.expires_at).toBe(0);
  });

  // Also covers a tick that is skipped while another holder's lease is live and resumes after it.
  it('two concurrent invocations never share the lease', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered!: () => void;
    const inTip = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const k1 = fakeKoios(founded());
    const tip = k1.tip.bind(k1);
    k1.tip = async () => {
      entered();
      await gate;
      return tip();
    };
    const first = run({ koios: k1 });
    await inTip;
    const held = await leaseRow();
    const metaBefore = await meta();
    const k2 = fakeKoios(founded());
    const second = await run({ koios: k2 });
    expect(second.lease).toBe('busy');
    expect(second.spent).toBe(3);
    expect(k2.calls).toEqual([]);
    expect(await leaseRow()).toEqual(held);
    expect(await meta()).toEqual(metaBefore);
    open();
    expect((await first).lease).toBe('held');
    expect((await leaseRow())?.expires_at).toBe(0);
    const third = await run({ chain: founded() });
    expect(third.lease).toBe('held');
  });

  it('touches no D1 with a remaining budget of 0', async () => {
    const r = await run({ chain: founded(), remaining: 0 });
    expect(r).toMatchObject({ lease: 'skipped', ingest: null, runs: 0, queries: 0, spent: 0 });
  });

  it('does only admin work and the release with a few queries left', async () => {
    await run({ chain: founded() });
    await real.prepare("UPDATE drep_group_meta SET lib_version = '0.0.1', operator_truncate = 150 WHERE id = 1").run();
    await real.prepare("INSERT INTO drep_group_power_changes (drep_id, seq, after_key) VALUES ('drep1x', 1, NULL)").run();
    await seedListed(1);
    const remaining = ADMIN_RESERVE_QUERIES + RELEASE_RESERVE_QUERIES + 3;
    const koios = fakeKoios(founded());
    const fetchImpl = siteFetch();
    const r = await run({ koios, remaining, fetchImpl });
    expect(r.lease).toBe('held');
    expect(r.ingest).toMatchObject({ newTxs: 0, newLedgerRows: 0 });
    expect(koios.calls).toEqual([]);
    expect(r.runs).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.queries).toBeLessThanOrEqual(remaining);
    expect(r.spent).toBe(r.queries);
    expect((await leaseRow())?.expires_at).toBe(0);
    const m = await meta();
    expect(m).toMatchObject({ operator_truncate: null, lib_version: LIBRARY_VERSION });
    expect(m.rec_first_kind).not.toBeNull();
    expect(r.recovery).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'power-scan'")).toBe(1);
  });

  it('runs no engine call when the allowance is below RUN_MAX_QUERIES', async () => {
    const r = await run({ chain: founded(), remaining: RUN_MAX_QUERIES - 1 });
    expect(r.lease).toBe('held');
    expect(r.ingest?.newTxs).toBe(1);
    expect(r.runs).toBe(0);
    expect(r.starved).toContain('engine');
    expect(await count('SELECT COUNT(*) AS n FROM drep_groups')).toBe(0);
    expect(await meta()).toMatchObject({ G_h: -1 });
  });

  it('skips due profiles once the work budget is spent', async () => {
    for (let n = 1; n <= 15; n++) await seedListed(n);
    const remaining = 60;
    const r = await run({ chain: creates(5), remaining, fetchImpl: siteFetch() });
    expect(r.profiles.fetched).toBeLessThan(15);
    expect(await dueCount('profile', 1_000)).toBe(15 - r.profiles.fetched);
    expect(r.queries).toBeLessThanOrEqual(remaining);
    expect(r.spent).toBe(r.queries);
  });

  it('handles profiles and websites at the exact budget edge', async () => {
    // The real cost of a selection, on an empty queue.
    const lease = (await acquireLease(real, invocationOwner())) as string;
    const sel = countingDb(real);
    await profilesToFetch(sel.db, 1_000, 10, lease);
    const selectCost = sel.meter.used();
    expect(selectCost).toBeLessThanOrEqual(PROFILE_SELECT_QUERIES);
    expect(selectCost).toBeLessThanOrEqual(WEBSITE_SELECT_QUERIES);

    await seedListed(1);
    const deps = (db: D1Database) => ({ db, lease, fetchImpl: siteFetch(), gateway: null, network: 'preprod' as const, now: 1_000 });
    const edge = async (limit: number) => {
      const c = countingDb(real);
      const phase = allowance(c.meter, limit);
      const report = { profiles: { fetched: 0, failed: 0 }, websites: { checked: 0, verified: 0 }, starved: [] as string[] };
      await maintainProfiles(deps(c.db), phase, report);
      expect(c.meter.used()).toBeLessThanOrEqual(limit - RELEASE_RESERVE_QUERIES);
      return { ...report, spent: c.meter.used() };
    };

    const profileEdge = PROFILE_SELECT_QUERIES + PROFILE_QUERIES_PER_ITEM + RELEASE_RESERVE_QUERIES;
    // One less: the profile stays due, only the website selection fits and finds nothing due.
    expect(await edge(profileEdge - 1)).toMatchObject({ profiles: { fetched: 0, failed: 0 }, websites: { checked: 0 } });
    expect(await dueCount('profile', 1_000)).toBe(1);
    const p = await edge(profileEdge);
    expect(p).toMatchObject({ profiles: { fetched: 1, failed: 0 }, websites: { checked: 0 } });
    expect(p.spent - selectCost).toBeLessThanOrEqual(PROFILE_QUERIES_PER_ITEM);
    expect(await dueCount('website', 1_000)).toBe(1);

    const websiteEdge = WEBSITE_SELECT_QUERIES + WEBSITE_QUERIES_PER_ITEM + RELEASE_RESERVE_QUERIES;
    expect(await edge(websiteEdge - 1)).toMatchObject({ profiles: { fetched: 0 }, websites: { checked: 0 }, spent: 0 });
    const w = await edge(websiteEdge);
    expect(w).toMatchObject({ profiles: { fetched: 0 }, websites: { checked: 1, verified: 1 } });
    expect(w.spent - selectCost).toBeLessThanOrEqual(WEBSITE_QUERIES_PER_ITEM);
    expect(await dueCount('website', 1_000)).toBe(0);
  });

  it('never exceeds the phase share', async () => {
    for (let n = 1; n <= 12; n++) await seedListed(n);
    const chain = foundings(200);
    const full = await run({ chain, fetchImpl: siteFetch() });
    // The budget stopped the engine with work left, not the run cap.
    expect(full.runs).toBeGreaterThan(0);
    expect(full.runs).toBeLessThan(MAX_ENGINE_RUNS_PER_TICK);
    expect(full.starved).toContain('engine');
    expect(full.queries).toBeLessThanOrEqual(GROUPS_QUERY_SHARE);
    expect(full.spent).toBe(full.queries);
    const usedBefore = 400;
    const part = await run({ chain, remaining: GOVERNANCE_QUERY_BUDGET - usedBefore, fetchImpl: siteFetch() });
    expect(part.queries).toBeLessThanOrEqual(GROUPS_QUERY_SHARE);
    expect(part.queries).toBeLessThanOrEqual(GOVERNANCE_QUERY_BUDGET - usedBefore);
  });

  it('an operator truncation opens once and clears its request', async () => {
    await run({ chain: founded() });
    expect(await count('SELECT COUNT(*) AS n FROM drep_groups')).toBe(1);
    await real.prepare('UPDATE drep_group_meta SET operator_truncate = 60 WHERE id = 1').run();
    // Below a run's worst case: the request opens the truncation and nothing steps it yet.
    const opened = await run({ chain: founded(), remaining: RUN_MAX_QUERIES - 1 });
    expect(opened.recovery).toEqual({ kind: 'truncate', above: 60 });
    expect(await meta()).toMatchObject({ operator_truncate: null, rec_first_kind: 'truncate', rec_first_above: 60 });
    // The engine works the truncation off, the request does not open it again.
    await run({ chain: founded() });
    expect(await meta()).toMatchObject({ operator_truncate: null, rec_first_kind: null });
    expect(await count('SELECT COUNT(*) AS n FROM drep_groups')).toBe(0);
    // The next tick reads the same canonical data again.
    const again = await run({ chain: founded() });
    expect(again.recovery).toBeNull();
    expect(await meta()).toMatchObject({ operator_truncate: null, rec_first_kind: null });
    expect(await one('SELECT members FROM drep_groups WHERE group_tx = ? AND group_ix = 0', hashBytes(T(1)))).toMatchObject({ members: 1 });
  });

  it('a lost lease mid phase ends it without an error and without a release', async () => {
    const seen: string[] = [];
    const recording = {
      prepare: (sql: string) => {
        seen.push(sql);
        return real.prepare(sql);
      },
      batch: <T = unknown>(stmts: D1PreparedStatement[]) => real.batch<T>(stmts),
      exec: (sql: string) => real.exec(sql),
      dump: () => real.dump(),
      withSession: (...args: Parameters<D1Database['withSession']>) => real.withSession(...args),
    } as unknown as D1Database;
    const koios = fakeKoios(founded());
    const tip = koios.tip.bind(koios);
    // Another holder takes over while this run waits on Koios.
    koios.tip = async () => {
      await real
        .prepare("UPDATE drep_group_lease SET owner = 'other', token = 'stolen', expires_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 600000 WHERE id = 1")
        .run();
      return tip();
    };
    const r = await run({ koios, db: recording });
    expect(r.lease).toBe('lost');
    expect(r.runs).toBe(0);
    expect(seen).not.toContain(Q.leaseRelease.sql);
    expect(await leaseRow()).toMatchObject({ owner: 'other', token: 'stolen' });
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_txs')).toBe(0);
  });

  it('resolves a create, a dissolve and an update made stale by a foreign update', async () => {
    const changes = new Map([[0, hexToBytes(control.hash)]]);
    const chain: Chain = {
      tip: 200,
      txs: [
        controlTx(T(1), 100, [ev.create(control.hash)], [control.bytes]),
        controlTx(T(2), 101, [ev.update(groupRef, 0, changes)]),
        controlTx(T(3), 102, [ev.update(groupRef, 0, changes)]),
        controlTx(T(4), 103, [[2, refCbor(groupRef), 1]]),
      ],
      regs: [],
    };
    await tracked('create', T(1), 1);
    await tracked('stale', T(3), 1);
    await tracked('dissolve', T(4), 1);
    const r = await run({ chain });
    expect(r.resolved).toEqual({ resolved: 3, neverIncluded: 0 });
    expect(await resolution('create')).toMatchObject({ resolution: 'applied', resolved_h: 100 });
    expect(await resolution('stale')).toMatchObject({ resolution: 'failed', resolved_h: 102 });
    expect(await resolution('dissolve')).toMatchObject({ resolution: 'applied', resolved_h: 103 });
    expect(await one('SELECT valid, reason FROM drep_group_own_outcomes WHERE tx_hash = ?', T(3))).toEqual({ valid: 0, reason: 'stale seq' });
  });

  it('writes groupless outcomes for an orphan approve', async () => {
    const chain: Chain = {
      tip: 200,
      txs: [controlTx(T(1), 100, [ev.create(control.hash), ev.approve({ txHash: T(0x77), index: 0 })], [control.bytes])],
      regs: [],
    };
    await tracked('orphan', T(1), 2);
    await run({ chain });
    const outcomes = await all('SELECT idx, valid, reason, at_h FROM drep_group_own_outcomes WHERE tx_hash = ? ORDER BY idx', T(1));
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ idx: 0, valid: 1, at_h: 100 });
    expect(outcomes[1]).toMatchObject({ idx: 1, valid: 0, at_h: 100 });
    expect(outcomes[1].reason).not.toBeNull();
    expect(outcomes[1].reason).not.toBe('no verdict recorded');
    expect(await resolution('orphan')).toMatchObject({ resolution: 'partial', resolved_h: 100 });
  });

  it('releases the lease and rethrows when a step fails', async () => {
    const koios = fakeKoios(founded());
    koios.tip = async () => {
      throw new Error('koios down');
    };
    await expect(run({ koios })).rejects.toThrow('koios down');
    expect((await leaseRow())?.expires_at).toBe(0);
  });
});

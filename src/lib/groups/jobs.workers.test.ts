/// <reference types="@cloudflare/workers-types" />
// The bounded jobs that keep DRepTalk's projection of the engine state: lazy closes, repairs and
// recomputes after a truncation, verdict trimming and the member power sum. Scenarios are built
// through the store's own commit, ledger ingest and recovery steps.
import { env } from 'cloudflare:test';
import type { Credential, EventRef, EventVerdict, Pos, StoredInstance } from 'drep-groups';
import { RETENTION_FLOOR, refKey } from 'drep-groups';
import { engineProjection } from 'drep-groups/conformance';
import { describe, expect, it } from 'vitest';
import { deactivateDreps, upsertDrep } from '../db/dreps.js';
import { drepArgs } from '../drepLink/__fixtures__/drepHandles.js';
import { type Allowance, allowance, countingDb, UNLIMITED } from '../sync/queryBudget.js';
import { D1DriverStore } from './__tests__/d1DriverStore.js';
import { credUnit, groupUnit, hex, instance, keyCred, pos, ref, txHashOf, version } from './__tests__/engineFixtures.js';
import { type Chain, ev, type FakeReg, type FakeTx, fakeKoios, K, payloadValue, sigScript, T, txCbor } from './__tests__/fixtures.js';
import { settle } from './__tests__/loadFixtures.js';
import { credBytes, hashBytes, posOrNull, refFromCols, type Row } from './codec.js';
import { ENGINE_BUDGET, JOB_MAX_QUERIES, MAX_JOB_ROWS_PER_RUN } from './constants.js';
import { drepIdForCredential } from './ids.js';
import { ingestDrepGroups } from './ingest.js';
import { enqueuePowerScan, type JobReport, jobsPending, runJobs } from './jobs.js';
import { commit } from './store/commit.js';
import { storeLedgerRows } from './store/ingest.js';
import { acquireLease, invocationOwner, releaseLease } from './store/lease.js';
import { finishRecovery, openRecovery, truncateStep } from './store/recovery.js';

const db = env.DB;
const NOW = 1_700_000_000_000;
const HEAVY = 120_000;

async function lease(): Promise<string> {
  const t = await acquireLease(db, invocationOwner());
  if (t === null) throw new Error('no lease');
  return t;
}

const all = async (sql: string, ...binds: unknown[]): Promise<Row[]> => (await db.prepare(sql).bind(...binds).all<Row>()).results ?? [];
const one = async (sql: string, ...binds: unknown[]): Promise<Row> => (await all(sql, ...binds))[0] as Row;
const count = async (sql: string, ...binds: unknown[]): Promise<number> => Number((await one(sql, ...binds)).n);
const jobs = (kind: string): Promise<number> => count('SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = ?', kind);
const range = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i);

// Group i is created at (10, 0, 2, i), member i is a key credential of its own.
const G = (i: number): EventRef => ref(10, i);
const created = (i: number): Pos => pos(10, 0, 2, i);
const M = (i: number): Credential => keyCred(1000 + i);
const drep = (c: Credential): string => drepIdForCredential(c);
const ANCHOR = { url: 'https://example.org/group.json', dataHash: hex(7, 64) };

async function track(creds: Credential[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO drep_group_tracked (cred, seq, known, history_done)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM drep_group_tracked), 1, 1)`,
  );
  for (let i = 0; i < creds.length; i += 50) {
    await db.batch(creds.slice(i, i + 50).map((c) => stmt.bind(credBytes(`${c.kind}:${c.hash}`))));
  }
}

async function createGroups(t: string, ids: number[], over: Partial<Parameters<typeof version>[3]> = {}): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const vs = ids.slice(i, i + 50).map((g) => version(G(g), created(g), created(g), over));
    await commit(db, [groupUnit(10, { versions: vs })], t);
  }
}

const joinRef = (at: Pos): EventRef => ({ txHash: at.txHash, index: at.index });
const joinOf = (c: Credential, g: number, at: Pos, over: Partial<StoredInstance> = {}): StoredInstance =>
  instance(joinRef(at), G(g), c, at, over);

/** Commits the instances, each by its member's credential unit applied through its join. */
async function join(t: string, items: StoredInstance[]): Promise<void> {
  for (let i = 0; i < items.length; i += 50) {
    await commit(db, items.slice(i, i + 50).map((x) => credUnit(x.member, x.joinedAt, { instances: [x] })), t);
  }
}

async function dissolve(t: string, g: number, h: number): Promise<void> {
  await commit(db, [groupUnit(h, { versions: [version(G(g), created(g), pos(h), { status: 'dissolved', seq: 1n })] })], t);
}

/** Stores an unreg at (h, 0, 0, 0) and applies it. */
async function retire(t: string, c: Credential, h: number): Promise<void> {
  const at = pos(h, 0, 0, 0);
  await storeLedgerRows(
    db,
    t,
    [
      {
        input: { kind: 'unreg', credential: c, txHash: txHashOf(h), blockHeight: h, txIndex: 0, certIndex: 0 },
        blockHash: hex(h, 64),
        blockTime: h * 20,
        witnessState: 'na',
        witness: null,
      },
    ],
    null,
  );
  await commit(db, [credUnit(c, at, { effects: [{ kind: 'credentialRetired', credential: c, at }] })], t);
}

async function truncate(t: string, above: number): Promise<void> {
  await openRecovery(db, { kind: 'truncate', above }, t, 0);
  for (let i = 0; (await truncateStep(db, above, 400, t)) !== 'done'; i++) if (i > 1000) throw new Error('truncation did not finish');
  await finishRecovery(db, { kind: 'truncate', above }, t);
}

/** Voting power rows written directly, before the instances exist, so no change is queued. */
async function powers(entries: Array<[Credential, string]>): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO dreps (drep_id, status, voting_power, last_synced_at, created_at) VALUES (?, 'registered', ?, 0, 0)
     ON CONFLICT (drep_id) DO UPDATE SET voting_power = excluded.voting_power`,
  );
  for (let i = 0; i < entries.length; i += 50) await db.batch(entries.slice(i, i + 50).map(([c, p]) => stmt.bind(drep(c), p)));
}

const setPower = (c: Credential, votingPower: string, lastSyncedAt = 0): Promise<void> =>
  upsertDrep(db, { ...drepArgs(drep(c), null), votingPower, lastSyncedAt });

function run(t: string, o: { maxRows?: number; budget?: Allowance; db?: D1Database } = {}): Promise<JobReport> {
  return runJobs(o.db ?? db, t, { maxRows: o.maxRows ?? MAX_JOB_ROWS_PER_RUN, budget: o.budget ?? UNLIMITED, now: NOW });
}

/** One page through the production meter with an allowance of one page. Every page fits JOB_MAX_QUERIES. */
async function onePage(t: string, maxRows = MAX_JOB_ROWS_PER_RUN, base: D1Database = db): Promise<JobReport> {
  const { db: counted, meter } = countingDb(base);
  const report = await runJobs(counted, t, { maxRows, budget: allowance(meter, JOB_MAX_QUERIES), now: NOW });
  expect(meter.used()).toBeLessThanOrEqual(JOB_MAX_QUERIES);
  return report;
}

async function groupRow(g: number): Promise<Row> {
  return one('SELECT *, CAST(member_power AS TEXT) AS power FROM drep_groups WHERE group_tx = ? AND group_ix = ?', hashBytes(G(g).txHash), G(g).index);
}

async function instanceRow(at: Pos): Promise<Row> {
  return one('SELECT * FROM drep_group_instances WHERE join_tx = ? AND join_ix = ?', hashBytes(at.txHash), at.index);
}

async function trackedRow(c: Credential): Promise<Row> {
  return one('SELECT * FROM drep_group_tracked WHERE cred = ?', credBytes(`${c.kind}:${c.hash}`));
}

async function jobRow(kind: string): Promise<Row | undefined> {
  return (await all('SELECT * FROM drep_group_jobs WHERE kind = ? ORDER BY id', kind))[0];
}

const counted = (state: string): string => (state === 'closed' ? 'former' : state === 'active' ? 'open' : 'pending');

/**
 * The stored caches and counters against the library's display projection of the stored state:
 * every instance's counted_as and effective close, every group's counters, and with `power` the
 * exact member power of its active members.
 */
async function expectFresh(o: { power?: boolean } = {}): Promise<void> {
  const proj = engineProjection(await new D1DriverStore(db).snapshot());
  const stored = new Map((await all('SELECT * FROM drep_group_instances')).map((r) => [refKey(refFromCols(r.join_tx, r.join_ix)), r]));
  for (const i of proj.instances) {
    const r = stored.get(refKey(i.joinId));
    expect(r, refKey(i.joinId)).toBeDefined();
    expect({ counted: r?.counted_as, eff: posOrNull(r as Row, 'eff'), reason: r?.eff_reason }).toEqual({
      counted: counted(i.state),
      eff: i.closedAt,
      reason: i.reason,
    });
  }
  expect(stored.size).toBe(proj.instances.length);
  const power = new Map((await all('SELECT drep_id, voting_power FROM dreps')).map((r) => [String(r.drep_id), BigInt(String(r.voting_power ?? 0))]));
  const verdicts = new Map<string, EventVerdict[]>();
  for (const v of proj.verdicts) if (v.group) verdicts.set(refKey(v.group), [...(verdicts.get(refKey(v.group)) ?? []), v]);
  for (const g of await all('SELECT *, CAST(member_power AS TEXT) AS power FROM drep_groups')) {
    const id = refFromCols(g.group_tx, g.group_ix);
    const own = proj.instances.filter((i) => refKey(i.group) === refKey(id));
    const vs = verdicts.get(refKey(id)) ?? [];
    const want: Row = {
      members: own.filter((i) => i.state === 'active').length,
      pending: own.filter((i) => i.state === 'pending').length,
      former: own.filter((i) => i.state === 'closed').length,
      applied_events: vs.filter((v) => v.valid).length + Number(g.trimmed_applied),
      not_applied_events: vs.filter((v) => !v.valid).length + Number(g.trimmed_not_applied),
    };
    if (o.power) {
      want.power = own
        .filter((i) => i.state === 'active')
        .reduce((s, i) => s + (power.get(drep(i.member)) ?? 0n), 0n)
        .toString();
    }
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, k === 'power' ? g.power : Number(g[k])]));
    expect(got, refKey(id)).toEqual(want);
  }
}

describe('dissolve jobs', () => {
  it('a dissolve job closes every member in pages and clears closing', { timeout: HEAVY }, async () => {
    const t = await lease();
    const members = range(450).map(M);
    await track(members);
    await createGroups(t, [0]);
    await join(t, members.map((c, i) => joinOf(c, 0, pos(20 + i))));
    expect(await groupRow(0)).toMatchObject({ members: 450 });
    await dissolve(t, 0, 1000);
    expect(await groupRow(0)).toMatchObject({ members: 450, closing: 1 });
    let pages = 0;
    while ((await jobs('dissolve')) > 0) {
      await onePage(t, 200);
      pages++;
    }
    expect(pages).toBe(3);
    expect(await groupRow(0)).toMatchObject({ members: 0, pending: 0, former: 450, closing: 0 });
    await run(t);
    await expectFresh();
  });

  it('a join committed after the dissolve job passed keeps its own dissolved cache', async () => {
    const t = await lease();
    const members = range(4).map(M);
    await track(members);
    await createGroups(t, [0]);
    await join(t, members.slice(0, 3).map((c, i) => joinOf(c, 0, pos(20 + i))));
    await dissolve(t, 0, 100);
    await onePage(t, 2);
    expect(JSON.parse(String((await jobRow('dissolve'))?.cursor_json)).after.slice(0, 1)).toEqual([21]);
    // A queued join below the job's cursor, applied after the dissolve was stored.
    const late = joinOf(members[3], 0, pos(20, 1));
    await join(t, [late]);
    expect(await instanceRow(late.joinedAt)).toMatchObject({ counted_as: 'former', eff_reason: 'dissolved', eff_h: 100 });
    await run(t);
    expect(await instanceRow(late.joinedAt)).toMatchObject({ counted_as: 'former', eff_reason: 'dissolved', eff_h: 100 });
    expect(await groupRow(0)).toMatchObject({ members: 0, former: 4, closing: 0 });
    expect(await jobs('dissolve')).toBe(0);
    await expectFresh();
  });

  it('a leave after the job turns dissolved into left without a second job', async () => {
    const t = await lease();
    const [a, b] = [M(0), M(1)];
    await track([a, b]);
    await createGroups(t, [0]);
    const ja = joinOf(a, 0, pos(20));
    await join(t, [ja, joinOf(b, 0, pos(21))]);
    await dissolve(t, 0, 100);
    await run(t);
    expect(await instanceRow(ja.joinedAt)).toMatchObject({ counted_as: 'former', eff_reason: 'dissolved' });
    // The leave at 50 was queued before the dissolve and is applied after the job finished.
    await commit(db, [credUnit(a, pos(50), { instances: [{ ...ja, closedAt: pos(50), closeReason: 'left' }] })], t);
    expect(await instanceRow(ja.joinedAt)).toMatchObject({ counted_as: 'former', eff_reason: 'left', eff_h: 50 });
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_jobs')).toBe(0);
    expect(await groupRow(0)).toMatchObject({ members: 0, former: 2 });
    await expectFresh();
  });
});

describe('retire and repair jobs', () => {
  it('a newer retirement between two retire pages restarts the pass and clears retiring only after it', { timeout: HEAVY }, async () => {
    const t = await lease();
    const m = M(0);
    await track([m]);
    await createGroups(t, range(301));
    await join(t, range(300).map((g) => joinOf(m, g, pos(20 + g))));
    await retire(t, m, 500);
    expect(await trackedRow(m)).toMatchObject({ retiring: 1, retired_at_h: 500 });
    await onePage(t, 100);
    const first = (await jobRow('retire'))?.cursor_json;
    expect(JSON.parse(String(first)).after[0]).toBe(119);
    // A new join and a newer retirement of the same credential.
    const late = joinOf(m, 300, pos(515));
    await join(t, [late]);
    await retire(t, m, 520);
    expect(await jobs('retire')).toBe(1);
    await onePage(t, 100);
    expect((await jobRow('retire'))?.cursor_json).toBe(first);
    // The rest at the production page size, every page within its query limit.
    while ((await jobs('retire')) > 0) {
      expect(await trackedRow(m)).toMatchObject({ retiring: 1, retired_at_h: 520 });
      await onePage(t);
    }
    expect(await trackedRow(m)).toMatchObject({ retiring: 0, retired_at_h: 520 });
    for (const g of [0, 150, 299]) expect(await instanceRow(pos(20 + g))).toMatchObject({ counted_as: 'former', eff_reason: 'retired', eff_h: 500 });
    expect(await instanceRow(late.joinedAt)).toMatchObject({ counted_as: 'former', eff_reason: 'retired', eff_h: 520 });
    await run(t);
    await expectFresh();
  });

  it('a repair clears retiring although the earlier retire job finished long ago', async () => {
    const t = await lease();
    const m = M(0);
    await track([m]);
    await createGroups(t, [0, 1]);
    await join(t, [joinOf(m, 0, pos(50)), joinOf(m, 1, pos(51))]);
    await retire(t, m, 60);
    await run(t);
    await retire(t, m, 90);
    await run(t);
    expect(await trackedRow(m)).toMatchObject({ retiring: 0, retired_at_h: 90 });
    await truncate(t, 80);
    expect(await trackedRow(m)).toMatchObject({ retiring: 1, retired_at_h: 60 });
    expect(await jobs('repair')).toBe(1);
    await run(t);
    expect(await trackedRow(m)).toMatchObject({ retiring: 0, retired_at_h: 60 });
    for (const at of [pos(50), pos(51)]) expect(await instanceRow(at)).toMatchObject({ counted_as: 'former', eff_reason: 'retired', eff_h: 60 });
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_jobs')).toBe(0);
    await expectFresh();
  });

  it('a repair reopens memberships closed by a rolled back retirement', async () => {
    const t = await lease();
    const [a, m] = [M(0), M(1)];
    await powers([
      [a, '5'],
      [m, '7'],
    ]);
    await track([a, m]);
    await createGroups(t, [0], { profile: ANCHOR, profileSetAt: created(0) });
    await join(t, [joinOf(a, 0, pos(20)), joinOf(m, 0, pos(21))]);
    await run(t);
    expect(await groupRow(0)).toMatchObject({ members: 2, power: '12' });
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_due WHERE kind = 'profile'")).toBe(1);
    await retire(t, m, 90);
    await run(t);
    expect(await groupRow(0)).toMatchObject({ members: 1, former: 1, power: '5' });
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_due')).toBe(0);
    await truncate(t, 80);
    expect(await trackedRow(m)).toMatchObject({ retiring: 0, retired_at_h: null });
    expect(await jobs('repair')).toBe(1);
    await run(t);
    expect(await instanceRow(pos(21))).toMatchObject({ counted_as: 'open', eff_h: null, eff_reason: null });
    expect(await groupRow(0)).toMatchObject({ members: 2, former: 0, power: '12' });
    expect(await one("SELECT due_at FROM drep_group_due WHERE kind = 'profile'")).toEqual({ due_at: NOW });
    await expectFresh({ power: true });
  });
});

describe('a retirement read through the Koios ingest', () => {
  const CONTROL = K(1);
  const control = sigScript(CONTROL);
  const KM = K(0x50);
  const credM: Credential = { kind: 'key', hash: KM };
  const reg = (action: FakeReg['action'], hash: string, height: number): FakeReg => ({ drepId: drep(credM), action, hash, height, index: 0 });
  const create: FakeTx = {
    hash: T(1),
    height: 100,
    index: 0,
    cbor: txCbor({ payload: payloadValue([ev.create(control.hash), ev.join(0, KM)], [control.bytes]), requiredSigners: [CONTROL, KM] }),
  };

  async function tick(chain: Chain): Promise<void> {
    const t = await lease();
    await ingestDrepGroups({ db, koios: fakeKoios(chain), lease: t, budget: UNLIMITED, now: 0 });
    await settle(db, t, ENGINE_BUDGET);
    await releaseLease(db, t);
  }

  it('a retire job closes with reason retired', async () => {
    const chain: Chain = { tip: 200, txs: [create], regs: [reg('registered', T(0x40), 50)] };
    await tick(chain);
    chain.tip = 400;
    chain.regs.push(reg('deregistered', T(0x41), 300), reg('registered', T(0x42), 305));
    await tick(chain);
    expect(await jobs('retire')).toBe(1);
    const t = await lease();
    await run(t);
    const group = one('SELECT * FROM drep_groups WHERE group_tx = ? AND group_ix = 0', hashBytes(T(1)));
    expect(await group).toMatchObject({ members: 0, former: 1 });
    expect(await one('SELECT counted_as, eff_reason, eff_h FROM drep_group_instances')).toEqual({ counted_as: 'former', eff_reason: 'retired', eff_h: 300 });
    expect(await trackedRow(credM)).toMatchObject({ retiring: 0, retired_at_h: 300 });
    await expectFresh();
  });
});

describe('recompute jobs', () => {
  it('recompute after a truncation that removed a dissolve reopens memberships and restores counters and member power', async () => {
    const t = await lease();
    const members = range(3).map(M);
    await powers(members.map((c, i) => [c, String(10 * (i + 1))]));
    await track(members);
    await createGroups(t, [0]);
    await join(t, members.map((c, i) => joinOf(c, 0, pos(20 + i))));
    await run(t);
    expect(await groupRow(0)).toMatchObject({ members: 3, power: '60' });
    await dissolve(t, 0, 60);
    await run(t);
    expect(await groupRow(0)).toMatchObject({ members: 0, former: 3, power: '0', closing: 0 });
    await truncate(t, 50);
    expect(await jobs('recompute')).toBe(1);
    await run(t);
    expect(await groupRow(0)).toMatchObject({ members: 3, former: 0, power: '60', closing: 0, dissolved_h: null });
    await expectFresh({ power: true });
  });

  it('recompute after a truncation above an earlier dissolve ends with closing 0 once no dissolve job remains', async () => {
    const t = await lease();
    const a = M(0);
    await track([a]);
    await createGroups(t, [0]);
    await join(t, [joinOf(a, 0, pos(20))]);
    await dissolve(t, 0, 40);
    await run(t);
    expect(await groupRow(0)).toMatchObject({ closing: 0, former: 1 });
    const late = { ref: { txHash: txHashOf(60), index: 0 }, tag: 'update' as const, valid: false, reason: 'group dissolved', at: pos(60), group: G(0), subject: null };
    await commit(db, [groupUnit(60, { verdicts: [late] })], t);
    expect(await groupRow(0)).toMatchObject({ not_applied_events: 1 });
    await truncate(t, 50);
    expect(await groupRow(0)).toMatchObject({ closing: 1 });
    expect(await jobs('recompute')).toBe(1);
    await run(t);
    expect(await groupRow(0)).toMatchObject({ closing: 0, former: 1, not_applied_events: 0 });
    expect(await jobs('dissolve')).toBe(0);
    await expectFresh();
  });

  describe('a rolled back leave, approval and dissolve rewrite the caches', () => {
    it('leave', async () => {
      const t = await lease();
      const a = M(0);
      await track([a]);
      await createGroups(t, [0]);
      const ja = joinOf(a, 0, pos(50));
      await join(t, [ja]);
      await commit(db, [credUnit(a, pos(90), { instances: [{ ...ja, closedAt: pos(90), closeReason: 'left' }] })], t);
      expect(await instanceRow(ja.joinedAt)).toMatchObject({ counted_as: 'former', eff_reason: 'left' });
      await truncate(t, 80);
      await run(t);
      expect(await instanceRow(ja.joinedAt)).toMatchObject({ counted_as: 'open', eff_h: null, eff_reason: null });
      expect(await groupRow(0)).toMatchObject({ members: 1, former: 0 });
      await expectFresh();
    });

    it('approval', async () => {
      const t = await lease();
      const a = M(0);
      await track([a]);
      await createGroups(t, [0], { mode: 'permissioned' });
      const ja = joinOf(a, 0, pos(50), { mode: 'permissioned' });
      await join(t, [ja]);
      expect(await groupRow(0)).toMatchObject({ members: 0, pending: 1 });
      await commit(db, [groupUnit(90, { instances: [{ ...ja, approvedAt: pos(90) }] })], t);
      expect(await groupRow(0)).toMatchObject({ members: 1, pending: 0 });
      await truncate(t, 80);
      await run(t);
      expect(await instanceRow(ja.joinedAt)).toMatchObject({ counted_as: 'pending', eff_h: null });
      expect(await groupRow(0)).toMatchObject({ members: 0, pending: 1, former: 0 });
      await expectFresh();
    });

    it('dissolve', async () => {
      const t = await lease();
      const a = M(0);
      await track([a]);
      await createGroups(t, [0]);
      const ja = joinOf(a, 0, pos(50));
      await join(t, [ja]);
      await dissolve(t, 0, 90);
      await run(t);
      expect(await instanceRow(ja.joinedAt)).toMatchObject({ counted_as: 'former', eff_reason: 'dissolved' });
      await truncate(t, 80);
      await run(t);
      expect(await instanceRow(ja.joinedAt)).toMatchObject({ counted_as: 'open', eff_h: null, eff_reason: null });
      expect(await groupRow(0)).toMatchObject({ members: 1, former: 0, closing: 0 });
      await expectFresh();
    });
  });

  it('a state change between two recompute pages restarts the count', { timeout: HEAVY }, async () => {
    const t = await lease();
    const members = range(300).map(M);
    const stranger = M(999);
    await track([...members, stranger]);
    await createGroups(t, [0], { mode: 'permissioned' });
    // Every member approved but member 250, every join with its verdict.
    await join(
      t,
      members.map((c, i) => joinOf(c, 0, pos(20 + i), { mode: 'permissioned', approvedAt: i === 250 ? null : pos(20 + i, 1) })),
    );
    const joinVerdicts: EventVerdict[] = members.map((c, i) => ({ ref: joinRef(pos(20 + i)), tag: 'join', valid: true, reason: null, at: pos(20 + i), group: G(0), subject: c }));
    const rejected: EventVerdict[] = range(30).map((i) => ({ ref: joinRef(pos(700 + i)), tag: 'join', valid: false, reason: 'x', at: pos(700 + i), group: G(0), subject: null }));
    await commit(db, [groupUnit(800, { verdicts: [...joinVerdicts.slice(0, 150)] })], t);
    await commit(db, [groupUnit(800, { verdicts: [...joinVerdicts.slice(150), ...rejected] })], t);
    await db
      .prepare("INSERT INTO drep_group_jobs (kind, job_key, group_tx, group_ix) VALUES ('recompute', ?, ?, ?)")
      .bind(refKey(G(0)), hashBytes(G(0).txHash), 0)
      .run();
    const cursor = async (): Promise<{ pass: string; after: number[] | null }> => JSON.parse(String((await jobRow('recompute'))?.cursor_json));
    await onePage(t, 100);
    const page0 = await cursor();
    expect(page0).toMatchObject({ pass: 'instances' });
    // After page one: an instance already counted closes, one not counted yet is approved.
    await commit(db, [credUnit(members[5], pos(2000), { instances: [{ ...joinOf(members[5], 0, pos(25), { mode: 'permissioned', approvedAt: pos(25, 1) }), closedAt: pos(2000), closeReason: 'left' }] })], t);
    await commit(db, [groupUnit(2001, { instances: [joinOf(members[250], 0, pos(270), { mode: 'permissioned', approvedAt: pos(2001) })] })], t);
    await onePage(t, 100);
    expect(await cursor()).toEqual(page0);
    const toVerdicts = async (): Promise<void> => {
      for (let i = 0; (await cursor()).pass === 'instances'; i++) {
        if (i > 10) throw new Error('instance pass did not end');
        await onePage(t, 100);
      }
      expect((await cursor()).pass).not.toBe('instances');
    };
    // During the verdict pass: a new control verdict, then a late credential verdict at an old position.
    await toVerdicts();
    await commit(db, [groupUnit(3000, { verdicts: [{ ref: joinRef(pos(3000)), tag: 'update', valid: true, reason: null, at: pos(3000), group: G(0), subject: null }] })], t);
    await onePage(t, 100);
    expect(await cursor()).toEqual(page0);
    await toVerdicts();
    await commit(
      db,
      [credUnit(stranger, pos(25, 2), { verdicts: [{ ref: joinRef(pos(25, 2)), tag: 'join', valid: false, reason: 'not a registered DRep', at: pos(25, 2), group: G(0), subject: stranger }] })],
      t,
    );
    await onePage(t, 100);
    expect(await cursor()).toEqual(page0);
    await run(t, { maxRows: 100 });
    expect(await jobs('recompute')).toBe(0);
    expect(await groupRow(0)).toMatchObject({ members: 299, pending: 0, former: 1, applied_events: 301, not_applied_events: 31 });
    await expectFresh();
  });

  it('a second rollback between two job pages leaves no stale count', { timeout: HEAVY }, async () => {
    const t = await lease();
    const members = range(300).map(M);
    await powers(members.map((c, i) => [c, String(i + 1)]));
    await track(members);
    await createGroups(t, [0]);
    await join(t, members.map((c, i) => joinOf(c, 0, pos(10 + i))));
    await run(t);
    const enqueue = (kind: string, key: string, cols: string, binds: unknown[]) =>
      db.prepare(`INSERT INTO drep_group_jobs (kind, job_key, ${cols}) VALUES (?, ?, ${binds.map(() => '?').join(', ')})`).bind(kind, key, ...binds).run();
    await enqueue('power', refKey(G(0)), 'group_tx, group_ix', [hashBytes(G(0).txHash), 0]);
    await onePage(t, 100);
    expect((await jobRow('power'))?.cursor_json).not.toBeNull();
    await enqueue('repair', `key:${members[0].hash}`, 'cred', [credBytes(`key:${members[0].hash}`)]);
    await onePage(t, 1);
    expect((await jobRow('repair'))?.cursor_json).not.toBeNull();
    await enqueue('recompute', refKey(G(0)), 'group_tx, group_ix', [hashBytes(G(0).txHash), 0]);
    await onePage(t, 100);
    expect((await jobRow('recompute'))?.cursor_json).not.toBeNull();
    await truncate(t, 50);
    await run(t);
    expect(await groupRow(0)).toMatchObject({ members: 41, power: String((41 * 42) / 2) });
    await expectFresh({ power: true });
  });

  it('publishes listing changes from job pages', async () => {
    const t = await lease();
    const [a, b] = [M(0), M(1)];
    await track([a, b]);
    await createGroups(t, [0], { profile: ANCHOR, profileSetAt: created(0) });
    await join(t, [joinOf(a, 0, pos(20)), joinOf(b, 0, pos(21))]);
    await run(t);
    // A stale counter below the listing threshold, as a rollback can leave it.
    await db.batch([db.prepare('DELETE FROM drep_group_due'), db.prepare('UPDATE drep_groups SET members = 0')]);
    await db
      .prepare("INSERT INTO drep_group_jobs (kind, job_key, group_tx, group_ix) VALUES ('recompute', ?, ?, 0)")
      .bind(refKey(G(0)), hashBytes(G(0).txHash))
      .run();
    await run(t);
    expect(await groupRow(0)).toMatchObject({ members: 2 });
    expect(await all('SELECT kind, due_at FROM drep_group_due')).toEqual([{ kind: 'profile', due_at: NOW }]);
    await db.prepare("INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at) VALUES ('website', ?, 0, 1)").bind(hashBytes(G(0).txHash)).run();
    await dissolve(t, 0, 100);
    await onePage(t);
    expect(await groupRow(0)).toMatchObject({ members: 0 });
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_due')).toBe(0);
  });
});

describe('trim jobs', () => {
  it('trims verdicts below the floor by position and keeps totals', async () => {
    const t = await lease();
    const late = M(5);
    await track([late]);
    await createGroups(t, [0]);
    await db.prepare('UPDATE drep_group_meta SET L = 5000 WHERE id = 1').run();
    const verdict = (h: number, valid: boolean, subject: Credential | null = null): EventVerdict => ({
      ref: joinRef(pos(h)),
      tag: valid ? 'update' : 'join',
      valid,
      reason: valid ? null : 'x',
      at: pos(h),
      group: G(0),
      subject,
    });
    await commit(db, [groupUnit(1500, { verdicts: [...range(300, 1000).map((h) => verdict(h, true)), ...range(60, 1400).map((h) => verdict(h, false))] })], t);
    expect(await groupRow(0)).toMatchObject({ applied_events: 300, not_applied_events: 60 });
    const heights = async (valid: number): Promise<number[]> =>
      (await all('SELECT at_h FROM drep_group_verdicts WHERE valid = ? ORDER BY at_h', valid)).map((r) => Number(r.at_h));
    const r = await run(t, { maxRows: 50 });
    expect(r.pages).toBe(3);
    expect(await heights(1)).toEqual(range(200, 1100));
    expect(await heights(0)).toEqual(range(50, 1410));
    expect(await groupRow(0)).toMatchObject({ applied_events: 300, not_applied_events: 60, trimmed_applied: 100, trimmed_not_applied: 10 });
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_trim_due')).toBe(0);
    // A late credential's verdicts at old positions are the oldest and go first.
    await commit(db, [credUnit(late, pos(539), { verdicts: range(40, 500).map((h) => verdict(h, true, late)) })], t);
    expect(await one('SELECT oldest_h FROM drep_group_trim_due')).toEqual({ oldest_h: 500 });
    await run(t);
    expect(await heights(1)).toEqual(range(200, 1100));
    expect(await groupRow(0)).toMatchObject({ applied_events: 340, trimmed_applied: 140 });
    await expectFresh();
  });
});

describe('trim scheduling', () => {
  const verdict = (h: number, valid: boolean): EventVerdict => ({
    ref: joinRef(pos(h)),
    tag: valid ? 'update' : 'join',
    valid,
    reason: valid ? null : 'x',
    at: pos(h),
    group: G(0),
    subject: null,
  });
  const setFloor = (floor: number) => db.prepare('UPDATE drep_group_meta SET L = ? WHERE id = 1').bind(floor + RETENTION_FLOOR).run();
  const trims = async (t: string): Promise<number> => (await run(t)).pages;

  it('does not pick a group again whose kept verdicts the floor passes', async () => {
    const t = await lease();
    await createGroups(t, [0]);
    await commit(db, [groupUnit(200, { verdicts: [...range(50, 100).map((h) => verdict(h, false)), ...range(50, 150).map((h) => verdict(h, true))] })], t);
    await setFloor(120);
    const gen = Number((await groupRow(0)).gen);
    // The first pick finds nothing to trim and leaves no due row: no class holds more than it keeps.
    expect(await trims(t)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_trim_due')).toBe(0);
    for (const floor of [121, 199, 200]) {
      await setFloor(floor);
      expect(await trims(t)).toBe(0);
    }
    expect(Number((await groupRow(0)).gen)).toBe(gen);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_verdicts')).toBe(100);
  });

  it('picks a group once its first trimmable verdict falls below the floor', async () => {
    const t = await lease();
    await createGroups(t, [0]);
    await commit(db, [groupUnit(1300, { verdicts: range(201, 1000).map((h) => verdict(h, true)) })], t);
    await setFloor(1100);
    const gen = Number((await groupRow(0)).gen);
    expect(await trims(t)).toBe(1);
    // Due again once the 201st oldest, at 1200, is below the floor.
    expect(await one('SELECT oldest_h FROM drep_group_trim_due')).toEqual({ oldest_h: 1200 });
    expect(Number((await groupRow(0)).gen)).toBe(gen);
    await setFloor(1200);
    expect(await trims(t)).toBe(0);
    await setFloor(1201);
    expect(await trims(t)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_verdicts')).toBe(200);
    expect(await one('SELECT MIN(at_h) AS h FROM drep_group_verdicts')).toEqual({ h: 1001 });
    expect(await groupRow(0)).toMatchObject({ trimmed_applied: 1, applied_events: 201, gen: gen + 1 });
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_trim_due')).toBe(0);
  });
});

describe('member power', () => {
  it('a changed member already summed by a running power pass ends in the right total', { timeout: HEAVY }, async () => {
    const t = await lease();
    const members = range(250).map(M);
    await powers(members.map((c) => [c, '1000']));
    await track(members);
    await createGroups(t, [0]);
    await join(t, members.map((c, i) => joinOf(c, 0, pos(10 + i))));
    await run(t);
    expect(await groupRow(0)).toMatchObject({ power: '250000' });
    const powerJob = () =>
      db.prepare("INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, group_tx, group_ix) VALUES ('power', ?, ?, 0)").bind(refKey(G(0)), hashBytes(G(0).txHash)).run();
    await powerJob();
    await onePage(t, 200);
    expect(JSON.parse(String((await jobRow('power'))?.cursor_json)).after[0]).toBe(209);
    // A member summed already changes its power through the DRep upsert.
    await setPower(members[5], '5000');
    await enqueuePowerScan(db, t);
    await run(t, { maxRows: 200 });
    expect(await groupRow(0)).toMatchObject({ power: '254000' });
    // In a second run a summed member leaves.
    await powerJob();
    await onePage(t, 200);
    await commit(db, [credUnit(members[7], pos(2000), { instances: [{ ...joinOf(members[7], 0, pos(17)), closedAt: pos(2000), closeReason: 'left' }] })], t);
    await run(t, { maxRows: 200 });
    expect(await groupRow(0)).toMatchObject({ members: 249, power: '253000' });
    await expectFresh({ power: true });
  });

  it('sums member power exactly above 2^53', async () => {
    const t = await lease();
    const [a, b] = [M(0), M(1)];
    await powers([
      [a, '9007199254740993'],
      [b, '2'],
    ]);
    await track([a, b]);
    await createGroups(t, [0]);
    await join(t, [joinOf(a, 0, pos(20)), joinOf(b, 0, pos(21))]);
    await run(t);
    expect(await groupRow(0)).toMatchObject({ power: '9007199254740995' });
    // Interrupted between its pages: one page per run.
    await db.batch([
      db.prepare('UPDATE drep_groups SET member_power = 0'),
      db.prepare("INSERT INTO drep_group_jobs (kind, job_key, group_tx, group_ix) VALUES ('power', ?, ?, 0)").bind(refKey(G(0)), hashBytes(G(0).txHash)),
    ]);
    let pages = 0;
    for (; (await jobs('power')) > 0; pages++) await onePage(t, 1);
    expect(pages).toBe(3);
    expect(await groupRow(0)).toMatchObject({ power: '9007199254740995' });
  });

  it('power scan picks only listed groups of DReps whose power changed', async () => {
    const t = await lease();
    const members = range(6).map(M);
    await powers(members.map((c) => [c, '1']));
    await track(members);
    await createGroups(t, [0, 1, 2, 3]);
    // Member 4 is also the only member of group 3, which is not listed.
    await join(t, [...members.map((c, i) => joinOf(c, i % 3, pos(20 + i))), joinOf(members[4], 3, pos(40))]);
    await run(t);
    expect(await groupRow(3)).toMatchObject({ members: 1 });
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_power_changes')).toBe(0);
    await setPower(members[4], '50');
    await enqueuePowerScan(db, t);
    expect(await jobs('power-scan')).toBe(1);
    await onePage(t);
    expect(await all('SELECT job_key FROM drep_group_jobs')).toEqual([{ job_key: refKey(G(1)) }]);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_power_changes')).toBe(0);
    await run(t);
    expect((await Promise.all([0, 1, 2].map(groupRow))).map((g) => g.power)).toEqual(['2', '51', '2']);
  });

  it('a scan between two DRep writes of the same sync misses nothing', async () => {
    const t = await lease();
    const [a, b, x, y] = range(4).map(M);
    await powers([a, b, x, y].map((c) => [c, '1']));
    await track([a, b, x, y]);
    await createGroups(t, [0, 1]);
    await join(t, [joinOf(a, 0, pos(20)), joinOf(x, 0, pos(21)), joinOf(b, 1, pos(22)), joinOf(y, 1, pos(23))]);
    await run(t);
    const tick = async (): Promise<void> => {
      await enqueuePowerScan(db, t);
      await run(t);
    };
    // One sync writes A, a groups tick runs, the same sync then writes B.
    await setPower(a, '10', 5);
    await tick();
    await setPower(b, '20', 5);
    await tick();
    expect((await Promise.all([0, 1].map(groupRow))).map((g) => g.power)).toEqual(['11', '21']);
    // A third write lands between a scan page's read and its batch.
    await setPower(a, '30', 6);
    await enqueuePowerScan(db, t);
    const before = Number((await one('SELECT seq FROM drep_group_power_changes')).seq);
    let hook: (() => Promise<void>) | null = () => setPower(a, '40', 7);
    const hooked = new Proxy(db, {
      get(target, p) {
        if (p === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            const h = hook;
            hook = null;
            if (h) await h();
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, p);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await onePage(t, MAX_JOB_ROWS_PER_RUN, hooked);
    const queued = await all('SELECT drep_id, seq, after_key FROM drep_group_power_changes');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ drep_id: drep(a), after_key: null });
    expect(Number(queued[0].seq)).toBeGreaterThan(before);
    await db.prepare("DELETE FROM drep_group_jobs WHERE kind = 'power'").run();
    await onePage(t);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_power_changes')).toBe(0);
    expect(await all("SELECT job_key FROM drep_group_jobs WHERE kind = 'power'")).toEqual([{ job_key: refKey(G(0)) }]);
    await run(t);
    expect((await groupRow(0)).power).toBe('41');
  });

  it('a DRep in more groups than MAX_JOB_ROWS_PER_RUN is scanned across pages and ticks', { timeout: HEAVY }, async () => {
    const t = await lease();
    const [x, y, z] = [M(0), M(1), M(2)];
    await powers([x, y, z].map((c) => [c, '1']));
    await track([x, y, z]);
    await createGroups(t, range(453));
    await join(t, [
      ...range(450).map((g) => joinOf(x, g, pos(20 + g))),
      ...range(453).map((g) => joinOf(y, g, pos(20 + g, 1))),
      ...range(3, 450).map((g) => joinOf(z, g, pos(20 + g, 2))),
    ]);
    expect(await count('SELECT COUNT(*) AS n FROM drep_groups WHERE members >= 2')).toBe(453);
    await db.prepare('DELETE FROM drep_group_jobs').run();
    await setPower(x, '99');
    await setPower(z, '77');
    const queue = () => all('SELECT drep_id, after_key FROM drep_group_power_changes ORDER BY seq');
    // Tick one: two pages, X still queued with its keyset.
    await enqueuePowerScan(db, t);
    for (const n of [200, 400]) {
      await onePage(t);
      expect(await jobs('power')).toBe(n);
      const q = await queue();
      expect(q.map((r) => r.drep_id)).toEqual([drep(x), drep(z)]);
      expect(q[0].after_key).not.toBeNull();
    }
    // Tick two: the last page of X, then Z behind it.
    await enqueuePowerScan(db, t);
    await onePage(t);
    expect(await jobs('power')).toBe(453);
    expect(await queue()).toEqual([]);
    expect(await jobs('power-scan')).toBe(0);
    await run(t);
    expect((await groupRow(0)).power).toBe('100');
    expect((await groupRow(450)).power).toBe('78');
  });

  it('deactivation queues a power change', async () => {
    const t = await lease();
    const [a, b] = [M(0), M(1)];
    await powers([
      [a, '100'],
      [b, '200'],
    ]);
    await track([a, b]);
    await createGroups(t, [0]);
    await join(t, [joinOf(a, 0, pos(20)), joinOf(b, 0, pos(21))]);
    await run(t);
    expect((await groupRow(0)).power).toBe('300');
    await deactivateDreps(db, [{ drepId: drep(a), status: 'retired', deposit: null, expiresEpochNo: null, lastSyncedAt: 1 }]);
    await enqueuePowerScan(db, t);
    await run(t);
    expect((await groupRow(0)).power).toBe('200');
  });
});

describe('runJobs', () => {
  async function pendingDissolve(t: string): Promise<void> {
    const a = M(0);
    await track([a]);
    await createGroups(t, [0]);
    await join(t, [joinOf(a, 0, pos(20))]);
    await run(t);
    await dissolve(t, 0, 100);
  }

  it('reports a recovery before a short allowance and more only with a job left', async () => {
    const t = await lease();
    const short = async (): Promise<JobReport> => {
      const { db: counted, meter } = countingDb(db);
      return runJobs(counted, t, { maxRows: MAX_JOB_ROWS_PER_RUN, budget: allowance(meter, JOB_MAX_QUERIES - 1), now: NOW });
    };
    await openRecovery(db, { kind: 'truncate', above: 200 }, t, 0);
    expect(await short()).toMatchObject({ pages: 0, skipped: 'recovery', more: false });
    await finishRecovery(db, { kind: 'truncate', above: 200 }, t);
    expect(await short()).toMatchObject({ pages: 0, skipped: null, more: false });
    await pendingDissolve(t);
    await openRecovery(db, { kind: 'truncate', above: 200 }, t, 0);
    expect(await short()).toMatchObject({ pages: 0, skipped: 'recovery', more: true });
  });

  it('runs no page while a recovery is open', async () => {
    const t = await lease();
    await pendingDissolve(t);
    await openRecovery(db, { kind: 'truncate', above: 200 }, t, 0);
    const r = await run(t);
    expect(r).toMatchObject({ pages: 0, rows: 0, finished: 0, skipped: 'recovery' });
    expect(await jobRow('dissolve')).toMatchObject({ cursor_json: null });
    expect(await jobsPending(db, ['dissolve'])).toBe(true);
  });

  it('runs no page when the allowance does not cover it', async () => {
    const t = await lease();
    await pendingDissolve(t);
    const { db: counted, meter } = countingDb(db);
    const r = await runJobs(counted, t, { maxRows: MAX_JOB_ROWS_PER_RUN, budget: allowance(meter, JOB_MAX_QUERIES - 1), now: NOW });
    expect(r).toMatchObject({ pages: 0, rows: 0, skipped: 'budget', more: true });
    // Only the selection ran, the page did not fit after it.
    expect(meter.used()).toBe(1);
    expect(await jobRow('dissolve')).toMatchObject({ cursor_json: null });
    const done = await run(t);
    expect(done).toMatchObject({ skipped: null, more: false });
    expect(done.pages).toBeGreaterThan(0);
    expect(await jobsPending(db, ['dissolve', 'retire', 'repair', 'recompute', 'trim', 'power', 'power-scan'])).toBe(false);
  });
});

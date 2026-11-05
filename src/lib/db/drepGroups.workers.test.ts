/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import type { EventRef } from 'drep-groups';
import { describe, expect, it } from 'vitest';
import { type GroupSeed, seedGroup as seedGroupRow } from '../groups/__tests__/engineFixtures.js';
import { keyHex as keyOf, txHex as txOf } from '../groups/__tests__/loadFixtures.js';
import { credBytes, hashBytes } from '../groups/codec.js';
import { drepIdForCredential, groupIdString } from '../groups/ids.js';
import { runJobs } from '../groups/jobs.js';
import { acquireLease, invocationOwner } from '../groups/store/lease.js';
import { openRecovery } from '../groups/store/recovery.js';
import { UNLIMITED } from '../sync/queryBudget.js';
import {
  drepNamesForKeyHashes,
  getGroup,
  groupsForDrep,
  listClosingMembers,
  listGroupIdsForSitemap,
  listListedGroups,
  listMembers,
  listVerdicts,
  type MemberRow,
  pendingVerification,
  profileAround,
  type ProfileRow,
  scriptDisplays,
  statusNote,
  upsertProfile,
} from './drepGroups.js';
import { myGroupsHref } from '../groups/myGroups.js';

const db = env.DB as D1Database;
const seedGroup = (n: number, o?: GroupSeed): Promise<void> => seedGroupRow(db, n, o);
const refOf = (n: number): EventRef => ({ txHash: txOf(n), index: 0 });
const idOf = (n: number): string => groupIdString(refOf(n));
const drepOf = (n: number): string => drepIdForCredential({ kind: 'key', hash: keyOf(n) });
const lease = async (): Promise<string> => (await acquireLease(db, invocationOwner())) as string;
const pos = (h: number): string => `${h}, 0, 2, 0, X'${txOf(h)}'`;

interface InstanceSeed {
  member: number;
  joined: number;
  mode?: 'open' | 'permissioned';
  approved?: number | null;
  closed?: { at: number; reason: 'left' | 'removed' } | null;
  counted?: 'open' | 'pending' | 'former';
}

async function seedInstance(group: number, join: number, o: InstanceSeed): Promise<void> {
  const c = o.closed ?? null;
  const a = o.approved ?? null;
  await db
    .prepare(
      `INSERT INTO drep_group_instances (join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode, joined_h, joined_ti, joined_ph,
        joined_ix, joined_tx, approved_h, approved_ti, approved_ph, approved_ix, approved_tx, closed_h, closed_ti, closed_ph,
        closed_ix, closed_tx, close_reason, counted_as)
       VALUES (?1, 0, ?2, 0, ?3, ?4, ?5, ${pos(o.joined)}, ${a === null ? 'NULL, NULL, NULL, NULL, NULL' : pos(a)},
        ${c === null ? 'NULL, NULL, NULL, NULL, NULL' : pos(c.at)}, ?6, ?7)`,
    )
    .bind(
      hashBytes(txOf(join)),
      hashBytes(txOf(group)),
      credBytes(`key:${keyOf(o.member)}`),
      drepOf(o.member),
      o.mode ?? 'open',
      c?.reason ?? null,
      o.counted ?? 'open',
    )
    .run();
}

async function seedDrep(n: number, o: { name?: string | null; slug?: string | null; power?: string } = {}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dreps (drep_id, status, voting_power, last_synced_at, created_at, name, slug)
       VALUES (?, 'registered', ?, 0, 0, ?, ?)`,
    )
    .bind(drepOf(n), o.power ?? '1000', o.name ?? null, o.slug ?? null)
    .run();
}

/** A tracked credential applied through height `applied`, optionally retiring. */
async function seedTracked(member: number, applied: number, retiring = 0): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drep_group_tracked (cred, seq, known, history_done, retiring, applied_h, applied_ti, applied_ph, applied_ix, applied_tx)
       VALUES (?, ?, 1, 1, ?, ${pos(applied)})`,
    )
    .bind(credBytes(`key:${keyOf(member)}`), member, retiring)
    .run();
}

async function seedLedger(member: number, kind: 'reg' | 'unreg', h: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, kind, block_height, block_hash, tx_index, block_time, witness_state)
       VALUES (?, 0, ?, ?, ?, ?, 0, 0, 'na')`,
    )
    .bind(hashBytes(txOf(900_000 + member * 1000 + h)), credBytes(`key:${keyOf(member)}`), kind, h, hashBytes(txOf(h)))
    .run();
}

const profile = (n: number, o: Partial<ProfileRow> = {}): ProfileRow => ({
  groupId: idOf(n),
  profileUrl: 'https://x.test/g.json',
  dataHash: '0a',
  status: 'ok',
  name: 'Council',
  description: null,
  website: 'https://x.test',
  image: null,
  charter: null,
  paymentAddresses: [],
  fetchedAt: 1,
  websiteVerifiedAt: null,
  websiteCheckedAt: null,
  ...o,
});

/** Every page of a member reader, with the keys each page returned. */
async function allPages(read: (after: string | null) => Promise<MemberRow[]>, size: number): Promise<MemberRow[][]> {
  const pages: MemberRow[][] = [];
  for (let after: string | null = null; ; ) {
    const page = await read(after);
    pages.push(page);
    if (page.length < size) return pages;
    after = page[page.length - 1].key;
  }
}

describe('drepGroups readers: groups', () => {
  it('keeps group fields when a profile row exists or not', async () => {
    await seedGroup(1, { status: 'dissolved' });
    expect(await getGroup(db, idOf(1))).toMatchObject({ groupId: idOf(1), status: 'dissolved', seq: '7', controlHash: 'aa', profile: null });
    const l = await lease();
    await upsertProfile(db, l, profile(1), 1);
    expect(await getGroup(db, idOf(1))).toMatchObject({ groupId: idOf(1), status: 'dissolved', profile: { status: 'ok', name: 'Council' } });
    await upsertProfile(db, l, profile(1, { status: 'fetch-failed', name: null }), 2);
    expect(await getGroup(db, idOf(1))).toMatchObject({ groupId: idOf(1), status: 'dissolved', profile: { status: 'fetch-failed', name: null } });
    expect(await getGroup(db, idOf(2))).toBeNull();
    expect(await getGroup(db, 'group1nope')).toBeNull();
  });

  it('lists groups with two active members by member voting power', async () => {
    await seedGroup(1, { members: 2, power: '300' });
    await seedGroup(2, { members: 2, power: '5001' });
    await seedGroup(3, { members: 1, power: '9999' });
    // A dissolved group whose members are closed is not listed, one still closing is, but not in the sitemap.
    await seedGroup(4, { members: 0, power: '0', status: 'dissolved' });
    await seedGroup(5, { members: 2, power: '101', status: 'dissolved', closing: 1 });
    await db
      .prepare("INSERT INTO drep_group_profiles (group_tx, group_ix, status, name, website_verified_at) VALUES (?, 0, 'ok', 'Council', 5)")
      .bind(hashBytes(txOf(2)))
      .run();
    const all = await listListedGroups(db, null, 10);
    expect(all.map((g) => [g.groupId, g.memberPower])).toEqual([
      [idOf(2), '5001'],
      [idOf(1), '300'],
      [idOf(5), '101'],
    ]);
    expect(all[0]).toMatchObject({ name: 'Council', websiteVerified: true, members: 2 });
    expect(all[1]).toMatchObject({ name: null, websiteVerified: false });
    const first = await listListedGroups(db, null, 1);
    const second = await listListedGroups(db, { power: first[0].memberPower, groupId: first[0].groupId }, 1);
    expect(second.map((g) => g.groupId)).toEqual([idOf(1)]);
    expect((await listListedGroups(db, { power: 'x', groupId: idOf(1) }, 1)).map((g) => g.groupId)).toEqual([idOf(2)]);
    expect((await listListedGroups(db, { power: '300', groupId: 'group1nope' }, 1)).map((g) => g.groupId)).toEqual([idOf(2)]);
    expect(await listGroupIdsForSitemap(db, 500)).toEqual([idOf(2), idOf(1)]);
  });

  it('pages groups whose member power exceeds 2^53 in exact order', async () => {
    const powers: Array<[number, string]> = [
      [1, '9007199254740993'],
      [2, '9007199254740992'],
      [3, '9007199254740994'],
      [4, '9007199254740993'],
      [5, '45000000000000001'],
    ];
    for (const [n, power] of powers) await seedGroup(n, { power });
    const seen: Array<[string, string]> = [];
    let after: { power: string; groupId: string } | null = null;
    for (;;) {
      const page = await listListedGroups(db, after, 2);
      seen.push(...page.map((g): [string, string] => [g.groupId, g.memberPower]));
      if (page.length < 2) break;
      after = { power: page[1].memberPower, groupId: page[1].groupId };
    }
    // Ties on power by group key, groups 1 and 4 hold the same power.
    expect(seen).toEqual([
      [idOf(5), '45000000000000001'],
      [idOf(3), '9007199254740994'],
      [idOf(1), '9007199254740993'],
      [idOf(4), '9007199254740993'],
      [idOf(2), '9007199254740992'],
    ]);
  });

  it('limits verdict lists', async () => {
    await seedGroup(1);
    const verdicts = (valid: number, from: number, count: number) =>
      db
        .prepare(
          `WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < ?3)
           INSERT INTO drep_group_verdicts (tx_hash, idx, group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, tag, valid, reason)
           SELECT unhex(printf('%064x', ?2 + s.i)), 0, ?1, 0, ?2 + s.i, 0, 2, 0, unhex(printf('%064x', ?2 + s.i)), 'join', ?4,
             CASE WHEN ?4 = 0 THEN 'not a member' END FROM s`,
        )
        .bind(hashBytes(txOf(1)), from, count, valid)
        .run();
    await verdicts(1, 1000, 250);
    await verdicts(0, 5000, 60);
    const applied = await listVerdicts(db, refOf(1), true, 500);
    expect(applied).toHaveLength(200);
    expect(applied[0]).toEqual({ txHash: txOf(1249), eventIndex: 0, tag: 'join', valid: true, reason: null, blockHeight: 1249, blockTime: null });
    expect(applied.at(-1)?.blockHeight).toBe(1050);
    // The block time comes from the stored label tx, else from the ledger row of a certificate tx.
    await db.batch([
      db
        .prepare(`INSERT INTO drep_group_txs (tx_hash, block_height, block_hash, tx_index, marker, block_time) VALUES (?, 1249, ?, 0, 0, 1700000000)`)
        .bind(hashBytes(txOf(1249)), hashBytes(txOf(1249))),
      db
        .prepare(
          `INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, kind, block_height, block_hash, tx_index, block_time, witness_state)
           VALUES (?, 0, X'00', 'reg', 1248, ?, 0, 1690000000, 'na')`,
        )
        .bind(hashBytes(txOf(1248)), hashBytes(txOf(1248))),
    ]);
    const timed = await listVerdicts(db, refOf(1), true, 3);
    expect(timed.map((v) => v.blockTime)).toEqual([1700000000, 1690000000, null]);
    expect(await listVerdicts(db, refOf(1), false, 500)).toHaveLength(50);
    expect(await listVerdicts(db, refOf(1), false, -1)).toEqual([]);
    const few = await listVerdicts(db, refOf(1), false, 5);
    expect(few.map((v) => v.blockHeight)).toEqual([5059, 5058, 5057, 5056, 5055]);
    expect(few[0]).toMatchObject({ valid: false, reason: 'not a member' });
  });

  it('caps the pending verification count at 100', async () => {
    await seedGroup(1, { closing: 1 });
    await seedGroup(2);
    const queue = (group: number, from: number, count: number, applied: number) =>
      db
        .prepare(
          `WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < ?3)
           INSERT INTO drep_group_queue (tx_hash, idx, subject, at_h, at_ti, at_ph, at_ix, at_tx, group_tx, group_ix, event_json, applied)
           SELECT unhex(printf('%064x', ?2 + s.i)), 0, X'00aa', ?2 + s.i, 0, 1, 0, unhex(printf('%064x', ?2 + s.i)), ?1, 0, '{}', ?4 FROM s`,
        )
        .bind(hashBytes(txOf(group)), from, count, applied)
        .run();
    await queue(1, 1000, 120, 0);
    await queue(2, 2000, 3, 0);
    await queue(2, 3000, 40, 1);
    expect(await pendingVerification(db, refOf(1))).toEqual({ closing: true, queued: 100, capped: true });
    expect(await pendingVerification(db, refOf(2))).toEqual({ closing: false, queued: 3, capped: false });
  });

  it('shows the active groups a DRep is an open member of', async () => {
    await seedGroup(1, { mode: 'permissioned' });
    await seedGroup(2);
    await seedGroup(3, { status: 'dissolved', closing: 1 });
    await db.prepare("INSERT INTO drep_group_profiles (group_tx, group_ix, status, name) VALUES (?, 0, 'ok', 'Council')").bind(hashBytes(txOf(1))).run();
    await seedInstance(1, 101, { member: 7, joined: 10, mode: 'permissioned', approved: 11 });
    await seedInstance(2, 102, { member: 7, joined: 10, closed: { at: 12, reason: 'left' }, counted: 'former' });
    await seedInstance(3, 103, { member: 7, joined: 10 });
    expect(await groupsForDrep(db, drepOf(7), 20)).toEqual([{ groupId: idOf(1), name: 'Council', mode: 'permissioned' }]);
    expect(await groupsForDrep(db, drepOf(8), 20)).toEqual([]);
  });

  it('links the account menu to the one group of a DRep, to the list for several, nothing for none', async () => {
    await seedGroup(1, { mode: 'permissioned' });
    await seedGroup(2);
    await seedGroup(3, { status: 'dissolved', closing: 1 });
    // A pending request counts, a closed membership and a dissolved group do not.
    await seedInstance(1, 101, { member: 7, joined: 10, mode: 'permissioned', counted: 'pending' });
    await seedInstance(2, 102, { member: 8, joined: 10, closed: { at: 12, reason: 'left' }, counted: 'former' });
    await seedInstance(3, 103, { member: 8, joined: 10 });
    expect(await myGroupsHref(db, drepOf(7))).toBe(`/groups/${idOf(1)}/`);
    expect(await myGroupsHref(db, drepOf(8))).toBeNull();
    await seedInstance(2, 104, { member: 7, joined: 11 });
    expect(await myGroupsHref(db, drepOf(7))).toBe('/groups/');
  });

  it('names DReps by the key hashes of their credentials', async () => {
    await seedDrep(1, { name: 'Alice' });
    await seedDrep(2, { name: null });
    const names = await drepNamesForKeyHashes(db, [keyOf(1), keyOf(2), keyOf(3)]);
    expect(names).toEqual(new Map([[keyOf(1), 'Alice']]));
    expect(await drepNamesForKeyHashes(db, [])).toEqual(new Map());
  });

  it('reads script displays by hash', async () => {
    await db
      .prepare(`INSERT INTO drep_group_scripts (hash, at_h, at_ti, at_ph, at_ix, at_tx, bytes, display_json) VALUES (?, ${pos(1)}, X'00', ?)`)
      .bind(hashBytes(keyOf(1)), '{"type":"sig"}')
      .run();
    expect(await scriptDisplays(db, [keyOf(1), keyOf(2)])).toEqual(new Map([[keyOf(1), '{"type":"sig"}']]));
  });
});

describe('drepGroups readers: members', () => {
  it('lists a closing group\'s members through effectiveClose in pages of 50 without reading the cache', async () => {
    await seedGroup(1, { status: 'dissolved', closing: 1, dissolvedAt: 500, members: 118 });
    // Wrong caches on purpose: a reader of counted_as would show these as pending.
    for (let i = 0; i < 120; i++) {
      const left = i < 2 ? { at: 200 + i, reason: 'left' as const } : null;
      await seedInstance(1, 1000 + i, { member: 10 + i, joined: 10 + i, closed: left, counted: 'pending' });
    }
    await seedDrep(10, { name: 'Alice', slug: 'alice', power: '5' });
    const pages = await allPages((after) => listClosingMembers(db, refOf(1), after), 50);
    expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
    const rows = pages.flat();
    expect(new Set(rows.map((r) => r.joinId)).size).toBe(120);
    expect(rows.map((r) => r.joinedHeight)).toEqual(Array.from({ length: 120 }, (_, i) => 10 + i));
    expect(rows[0]).toMatchObject({ drepId: drepOf(10), drepName: 'Alice', drepSlug: 'alice', votingPower: '5', state: 'closed', reason: 'left', closedHeight: 200 });
    expect(rows.slice(2).every((r) => r.state === 'closed' && r.reason === 'dissolved' && r.closedHeight === 500)).toBe(true);
    // The same cursor gives the same page.
    expect(await listClosingMembers(db, refOf(1), pages[0][49].key)).toEqual(pages[1]);
  });

  it('keeps a retiring member on the page with a mark and a stable keyset', async () => {
    await seedGroup(1, { members: 3 });
    for (const m of [1, 2, 3]) await seedInstance(1, 100 + m, { member: m, joined: 10 + m });
    await seedTracked(1, 100);
    // Member 2 deregistered after its join, the unreg is applied, the retire job not run yet.
    await seedTracked(2, 100, 1);
    await seedLedger(2, 'unreg', 50);
    // Member 3 has a stored ledger row above its applied position.
    await seedTracked(3, 100);
    await seedLedger(3, 'unreg', 150);
    const pages = await allPages((after) => listMembers(db, refOf(1), 'active', after, 2), 2);
    expect(pages.map((p) => p.map((r) => [r.joinedHeight, r.state, r.reason, r.mark]))).toEqual([
      [
        [11, 'active', null, null],
        [12, 'closed', 'retired', null],
      ],
      [[13, 'active', null, 'unapplied']],
    ]);
    expect(pages[0][1].closedHeight).toBe(50);
    expect(await listMembers(db, refOf(1), 'active', pages[0][0].key, 2)).toEqual([pages[0][1], pages[1][0]]);
    expect(await listMembers(db, refOf(1), 'pending', null, 50)).toEqual([]);
  });

  it('marks only the pending or active rows of a retiring member', async () => {
    await seedGroup(1, { members: 1 });
    await seedInstance(1, 101, { member: 4, joined: 14, closed: { at: 15, reason: 'left' }, counted: 'former' });
    await seedInstance(1, 102, { member: 4, joined: 16 });
    await seedTracked(4, 100, 1);
    expect((await listMembers(db, refOf(1), 'former', null, 50)).map((r) => [r.joinedHeight, r.state, r.mark])).toEqual([[14, 'closed', null]]);
    expect((await listMembers(db, refOf(1), 'active', null, 50)).map((r) => [r.joinedHeight, r.state, r.mark])).toEqual([[16, 'active', 'retiring']]);
  });

  it('lists pending and former members by their counted_as list', async () => {
    await seedGroup(1, { mode: 'permissioned', members: 1 });
    await seedInstance(1, 101, { member: 1, joined: 10, mode: 'permissioned', approved: 11 });
    await seedInstance(1, 102, { member: 2, joined: 12, mode: 'permissioned', counted: 'pending' });
    await seedInstance(1, 103, { member: 3, joined: 13, mode: 'permissioned', approved: 14, closed: { at: 15, reason: 'removed' }, counted: 'former' });
    expect((await listMembers(db, refOf(1), 'active', null, 50)).map((r) => [r.drepId, r.state, r.approvedHeight])).toEqual([[drepOf(1), 'active', 11]]);
    expect((await listMembers(db, refOf(1), 'pending', null, 50)).map((r) => [r.drepId, r.state])).toEqual([[drepOf(2), 'pending']]);
    expect((await listMembers(db, refOf(1), 'former', null, 50)).map((r) => [r.drepId, r.state, r.reason, r.closedHeight])).toEqual([
      [drepOf(3), 'closed', 'removed', 15],
    ]);
  });
});

describe('drepGroups readers: status note', () => {
  const job = (kind: string, key: string, group: number | null, cred: number | null) =>
    db
      .prepare('INSERT INTO drep_group_jobs (kind, job_key, group_tx, group_ix, cred) VALUES (?, ?, ?, ?, ?)')
      .bind(kind, key, group === null ? null : hashBytes(txOf(group)), group === null ? null : 0, cred === null ? null : credBytes(`key:${keyOf(cred)}`))
      .run();
  const drain = async (l: string) => runJobs(db, l, { maxRows: 200, budget: UNLIMITED, now: 0 });

  it('reports correcting until the recompute jobs drain', async () => {
    expect(await statusNote(db)).toBeNull();
    await seedGroup(1);
    await job('recompute', 'g1', 1, null);
    expect(await statusNote(db)).toBe('correcting');
    await drain(await lease());
    expect(await db.prepare("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'recompute'").first()).toEqual({ n: 0 });
    expect(await statusNote(db)).toBeNull();
  });

  it('reports correcting while only a repair job remains', async () => {
    await seedTracked(1, 10);
    await job('repair', 'c1', null, 1);
    await job('power-scan', 'power-scan', null, null);
    expect(await statusNote(db)).toBe('correcting');
    await db.prepare("DELETE FROM drep_group_jobs WHERE kind = 'repair'").run();
    expect(await statusNote(db)).toBeNull();
  });

  it('reports correcting during a fork that replaced a rebuild', async () => {
    const l = await lease();
    await openRecovery(db, { kind: 'rebuild' }, l);
    expect(await statusNote(db)).toBe('rebuilding');
    await openRecovery(db, { kind: 'fork' }, l);
    expect(await db.prepare('SELECT rec_first_kind, rebuilding FROM drep_group_meta WHERE id = 1').first()).toEqual({ rec_first_kind: 'fork', rebuilding: 0 });
    expect(await statusNote(db)).toBe('correcting');
  });

  it('reports rebuilding from the meta flag only', async () => {
    // A label backlog, G far behind L, is no note of its own.
    await db.prepare('UPDATE drep_group_meta SET L = 1000 WHERE id = 1').run();
    expect(await statusNote(db)).toBeNull();
    // The flag outlives the rebuild slot until the replay reaches L.
    await db.prepare('UPDATE drep_group_meta SET rebuilding = 1 WHERE id = 1').run();
    expect(await statusNote(db)).toBe('rebuilding');
  });
});

describe('drepGroups readers: profile around an update', () => {
  const NEW = 'ab'.repeat(32);
  const OLD = 'cd'.repeat(32);
  const doc = (name: string): string => JSON.stringify({ body: { name } });
  const seedDoc = (hash: string, name: string) =>
    db.prepare("INSERT INTO drep_group_profile_docs (hash, body, created_by, created_at) VALUES (?, ?, 'u', 0)").bind(hash, doc(name)).run();
  const seedVersion = (group: number, h: number, profileHash: string | null) =>
    db
      .prepare(
        `INSERT INTO drep_group_versions (group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, mode, control, profile_hash, seq, status,
          created_h, created_ti, created_ph, created_ix, created_tx)
         VALUES (?1, 0, ?2, 0, 2, 0, X'aa', 'open', X'01', ?3, '7', 'active', 1, 0, 2, 0, X'aa')`,
      )
      .bind(hashBytes(txOf(group)), h, profileHash === null ? null : hashBytes(profileHash))
      .run();
  const seedStored = (group: number, hash: string, name: string) =>
    db
      .prepare("INSERT INTO drep_group_profiles (group_tx, group_ix, data_hash, status, name) VALUES (?, 0, ?, 'ok', ?)")
      .bind(hashBytes(txOf(group)), hashBytes(hash), name)
      .run();

  it('has no before for a group that is not founded yet', async () => {
    await seedDoc(NEW, 'New');
    const r = await profileAround(db, null, NEW);
    expect(r.before).toBeNull();
    expect(r.after?.name).toBe('New');
  });

  it('takes the before from the stored profile while it has another anchor', async () => {
    await seedGroup(1);
    await seedDoc(NEW, 'New');
    await seedStored(1, OLD, 'Old');
    const r = await profileAround(db, refOf(1), NEW);
    expect(r.before?.name).toBe('Old');
    expect(r.after?.name).toBe('New');
  });

  it('takes the before from the latest earlier anchor once the update is in effect', async () => {
    await seedGroup(1);
    await seedDoc(NEW, 'New');
    await seedDoc(OLD, 'Old');
    await seedStored(1, NEW, 'New');
    await seedVersion(1, 5, OLD);
    await seedVersion(1, 6, NEW);
    const r = await profileAround(db, refOf(1), NEW);
    expect(r.before?.name).toBe('Old');
    expect(r.after?.name).toBe('New');
  });

  it('leaves a side null when its document is not hosted', async () => {
    await seedGroup(1);
    await seedStored(1, NEW, 'New');
    await seedVersion(1, 5, OLD);
    expect(await profileAround(db, refOf(1), NEW)).toEqual({ before: null, after: null });
  });
});

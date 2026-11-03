/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import type { ChangeSet, Credential, CursorUpdate, EventRef, Pos, StoredInstance } from 'drep-groups';
import type { NativeScript } from 'drep-groups';
import { credKey, endOf, LeaseLostError, majorityScript, parseNativeScript, refKey } from 'drep-groups';
import { describe, expect, it } from 'vitest';
import { D1_MAX_BINDS } from '../../db/sql.js';
import {
  bindCountingDb,
  credUnit,
  deepScript,
  emptyChange,
  emptyPreRead,
  groupUnit,
  hex,
  instance,
  keyCred,
  pos,
  ref,
  txHashOf,
  version,
  worstCaseCredentialUnits,
  worstCaseGroupUnits,
} from '../__tests__/engineFixtures.js';
import { sigScript } from '../__tests__/fixtures.js';
import { profilesToFetch } from '../../db/drepGroups.js';
import { ENGINE_BUDGET } from '../constants.js';
import { groupIdString } from '../ids.js';
import { credBytes, hashBytes, posOrNull, type Row } from '../codec.js';
import { acquireLease, invocationOwner } from './lease.js';
import { commit, commitStatements, preRead } from './commit.js';

const db = env.DB;
type Unit = { change: ChangeSet; cursor: CursorUpdate };

const G = ref(10);
const CREATED = pos(10);
const certPos = (h: number, ix = 0): Pos => pos(h, 0, 0, ix);
const cb = (c: Credential): Uint8Array => credBytes(credKey(c));
const GTX = hashBytes(G.txHash);

const join = (h: number): EventRef => ({ txHash: txHashOf(h), index: 0 });
const joined = (h: number, c: Credential, over: Partial<StoredInstance> = {}): StoredInstance =>
  instance(join(h), G, c, pos(h), over);
const create = (over: Parameters<typeof version>[3] = {}): Unit => groupUnit(10, { versions: [version(G, CREATED, CREATED, over)] });

async function lease(): Promise<string> {
  const t = await acquireLease(db, invocationOwner());
  if (t === null) throw new Error('no lease');
  return t;
}

async function group(): Promise<Row> {
  const r = await db.prepare('SELECT * FROM drep_groups WHERE group_tx = ? AND group_ix = ?').bind(GTX, G.index).first<Row>();
  if (!r) throw new Error('group row missing');
  return r;
}

async function inst(h: number): Promise<Row> {
  const r = await db.prepare('SELECT * FROM drep_group_instances WHERE join_tx = ? AND join_ix = 0').bind(hashBytes(txHashOf(h))).first<Row>();
  if (!r) throw new Error('instance row missing');
  return r;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return Number((await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n);
}

async function track(c: Credential, seq: number): Promise<void> {
  await db
    .prepare('INSERT INTO drep_group_tracked (cred, seq, known, history_done) VALUES (?, ?, 1, 1)')
    .bind(cb(c), seq)
    .run();
}

async function tracked(c: Credential): Promise<Row> {
  const r = await db.prepare('SELECT * FROM drep_group_tracked WHERE cred = ?').bind(cb(c)).first<Row>();
  if (!r) throw new Error('tracked row missing');
  return r;
}

async function ledger(c: Credential, kind: 'reg' | 'unreg', h: number, certIndex = 0): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, kind, block_height, block_hash, tx_index,
         block_time, witness, witness_state)
       VALUES (?, ?, ?, ?, ?, X'0b', 0, 0, NULL, 'na')`,
    )
    .bind(hashBytes(txHashOf(h)), certIndex, cb(c), kind, h)
    .run();
}

async function pendingRow(id: string, bodyHash: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_multisig_tx (id, drep_id, action, action_params, unsigned_tx_cbor, body_hash, native_script,
         created_by, created_at, expires_at, subject_kind)
       VALUES (?, 'g', 'group_update', '{}', '00', ?, '{}', 'u1', 1, 2, 'group')`,
    )
    .bind(id, bodyHash)
    .run();
}

async function labelTx(h: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drep_group_txs (tx_hash, block_height, block_hash, tx_index, marker, payload, required_signers,
         witness_key_hashes, invalid_before, invalid_hereafter, is_valid, payload_repeated, bytes)
       VALUES (?, ?, X'0b', 0, 0, x'00', X'', X'', NULL, NULL, 1, 0, 1)`,
    )
    .bind(hashBytes(txHashOf(h)), h)
    .run();
}

// Worst case of one commit batch. Measured, guard included: 85 for the group commit, 34 for the credential commit.
const COMMIT_MAX_STATEMENTS = 150;

describe('drep groups commit', () => {
  it('fits a worst case group commit and a worst case credential commit into one batch', () => {
    const groupCommit = worstCaseGroupUnits(ENGINE_BUDGET.controlTxs);
    const credCommit = worstCaseCredentialUnits(ENGINE_BUDGET.credentialUnits, ENGINE_BUDGET.credentialInputs);
    for (const units of [groupCommit, credCommit]) {
      const { db: counted, maxBinds } = bindCountingDb(env.DB);
      const stmts = commitStatements(counted, units, emptyPreRead());
      expect(stmts.length + 2).toBeLessThanOrEqual(COMMIT_MAX_STATEMENTS);
      expect(maxBinds()).toBeLessThanOrEqual(D1_MAX_BINDS);
    }
  });

  it('applies a counter delta once per counted_as change', async () => {
    const t = await lease();
    const a = keyCred(1);
    await track(a, 1);
    await commit(db, [create()], t);
    await commit(db, [credUnit(a, pos(20), { instances: [joined(20, a)] })], t);
    expect(await group()).toMatchObject({ members: 1, pending: 0, former: 0 });
    await commit(db, [credUnit(a, pos(20), { instances: [joined(20, a)] })], t);
    expect(await group()).toMatchObject({ members: 1, pending: 0, former: 0 });
    await commit(db, [credUnit(a, pos(25), { instances: [joined(20, a, { closedAt: pos(25), closeReason: 'left' })] })], t);
    expect(await group()).toMatchObject({ members: 0, pending: 0, former: 1 });
    expect(await inst(20)).toMatchObject({ counted_as: 'former', eff_reason: 'left', eff_h: 25 });
  });

  it('keeps the counters through a later update of the group', async () => {
    const t = await lease();
    const [a, b] = [keyCred(1), keyCred(2)];
    await commit(db, [create()], t);
    await commit(
      db,
      [credUnit(a, pos(20), { instances: [joined(20, a)] }), credUnit(b, pos(21), { instances: [joined(21, b)] })],
      t,
    );
    expect(await group()).toMatchObject({ members: 2 });
    await commit(db, [groupUnit(30, { versions: [version(G, CREATED, pos(30), { seq: 1n, control: 'ab' })] })], t);
    expect(await group()).toMatchObject({ members: 2, control: [0xab], cur_h: 30, seq: '1' });
  });

  it('caches dissolved for a join committed after the dissolve and left after a later leave', async () => {
    const t = await lease();
    const a = keyCred(1);
    await commit(db, [create()], t);
    await commit(
      db,
      [
        groupUnit(30, {
          versions: [version(G, CREATED, pos(30), { seq: 1n, status: 'dissolved' })],
          effects: [{ kind: 'groupDissolved', group: G, at: pos(30) }],
        }),
      ],
      t,
    );
    expect(await group()).toMatchObject({ closing: 1, dissolved_h: 30, status: 'dissolved' });
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'dissolve' AND job_key = ?", refKey(G))).toBe(1);
    await commit(db, [credUnit(a, pos(20), { instances: [joined(20, a)] })], t);
    expect(await inst(20)).toMatchObject({ counted_as: 'former', eff_reason: 'dissolved', eff_h: 30 });
    expect(await group()).toMatchObject({ members: 0, former: 1 });
    await commit(db, [credUnit(a, pos(25), { instances: [joined(20, a, { closedAt: pos(25), closeReason: 'left' })] })], t);
    expect(await inst(20)).toMatchObject({ counted_as: 'former', eff_reason: 'left', eff_h: 25 });
    expect(await group()).toMatchObject({ members: 0, former: 1 });
  });

  it('increments gen once per touched group and publishes deltas while a recompute runs', async () => {
    const t = await lease();
    const [a, b] = [keyCred(1), keyCred(2)];
    await commit(db, [create()], t);
    await commit(
      db,
      [credUnit(a, pos(20), { instances: [joined(20, a)] }), credUnit(b, pos(21), { instances: [joined(21, b)] })],
      t,
    );
    const before = await group();
    await db
      .prepare(
        `INSERT INTO drep_group_jobs (kind, job_key, group_tx, group_ix, cursor_json, staging, start_gen)
         VALUES ('recompute', ?, ?, ?, '{"pass":"instances","after":"x"}', '{"members":1}', ?)`,
      )
      .bind(refKey(G), GTX, G.index, before.gen)
      .run();
    const job = await db.prepare("SELECT * FROM drep_group_jobs WHERE kind = 'recompute'").first<Row>();
    const control = { ref: { txHash: txHashOf(30), index: 0 }, tag: 'update' as const, valid: true, reason: null, at: pos(30), group: G, subject: null };
    const late = { ref: { txHash: txHashOf(26), index: 1 }, tag: 'approve' as const, valid: false, reason: 'x', at: pos(26, 0, 2, 1), group: G, subject: b };
    await commit(
      db,
      [
        groupUnit(30, { versions: [version(G, CREATED, pos(30), { seq: 1n })], verdicts: [control] }),
        credUnit(a, pos(25), { instances: [joined(20, a, { closedAt: pos(25), closeReason: 'left' })] }),
        credUnit(b, pos(26, 0, 2, 1), { verdicts: [late] }),
      ],
      t,
    );
    const after = await group();
    expect(after).toMatchObject({
      members: Number(before.members) - 1,
      former: Number(before.former) + 1,
      applied_events: Number(before.applied_events) + 1,
      not_applied_events: Number(before.not_applied_events) + 1,
      gen: Number(before.gen) + 1,
    });
    expect(await db.prepare("SELECT * FROM drep_group_jobs WHERE kind = 'recompute'").first<Row>()).toEqual(job);
    // A retried result writes no second delta.
    await commit(db, [credUnit(b, pos(26, 0, 2, 1), { verdicts: [late] })], t);
    expect(await group()).toMatchObject({ not_applied_events: Number(before.not_applied_events) + 1 });
    expect(await count('SELECT oldest_h AS n FROM drep_group_trim_due WHERE group_tx = ?', GTX)).toBe(26);
  });

  it('reads the first applied unreg per join with one bounded lookup', async () => {
    const a = keyCred(1);
    await ledger(a, 'unreg', 15);
    for (let h = 30; h < 80; h++) await ledger(a, 'unreg', h);
    let rowsRead = 0;
    const measured = new Proxy(db, {
      get(target, p) {
        if (p === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            const res = await target.batch(stmts);
            for (const r of res) rowsRead += r.meta.rows_read ?? 0;
            return res;
          };
        }
        const v = Reflect.get(target, p);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const pre = await preRead(measured, [credUnit(a, pos(100), { instances: [joined(20, a)] })]);
    expect(pre.firstUnreg.get(refKey(join(20)))).toEqual(certPos(30));
    expect(rowsRead).toBeLessThan(10);
    // Bounded above by the applied position.
    const below = await preRead(db, [credUnit(a, pos(29), { instances: [joined(20, a)] })]);
    expect(below.firstUnreg.get(refKey(join(20)))).toBeNull();
  });

  it('keeps one retire job per credential and increments its gen per unreg', async () => {
    const t = await lease();
    const a = keyCred(1);
    await track(a, 1);
    const gen0 = Number((await tracked(a)).gen);
    await commit(db, [credUnit(a, certPos(30), { effects: [{ kind: 'credentialRetired', credential: a, at: certPos(30) }] })], t);
    await commit(db, [credUnit(a, certPos(40), { effects: [{ kind: 'credentialRetired', credential: a, at: certPos(40) }] })], t);
    const row = await tracked(a);
    expect(row.retiring).toBe(1);
    expect(posOrNull(row, 'retired_at')).toEqual(certPos(40));
    expect(Number(row.gen)).toBe(gen0 + 2);
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'retire' AND job_key = ?", credKey(a))).toBe(1);
  });

  it('writes the profile due row at one member and the website due row at two', async () => {
    const t = await lease();
    const [a, b] = [keyCred(1), keyCred(2)];
    const anchor = { url: 'https://example.org/g.json', dataHash: 'aa'.repeat(32) };
    const due = (kind: string) => count('SELECT COUNT(*) AS n FROM drep_group_due WHERE kind = ? AND group_tx = ?', kind, GTX);
    await commit(db, [create({ profile: anchor, profileSetAt: CREATED })], t);
    expect(await due('profile')).toBe(0);
    await commit(db, [credUnit(a, pos(20), { instances: [joined(20, a)] })], t);
    expect(await due('profile')).toBe(1);
    expect(await due('website')).toBe(0);
    // The profile was fetched before the second member and names a website.
    await db
      .prepare(
        `INSERT INTO drep_group_profiles (group_tx, group_ix, profile_url, data_hash, status, website, fetched_at)
         VALUES (?, ?, ?, ?, 'ok', 'https://example.org', 1)`,
      )
      .bind(GTX, G.index, anchor.url, hashBytes(anchor.dataHash))
      .run();
    await commit(db, [credUnit(b, pos(21), { instances: [joined(21, b)] })], t);
    expect(await group()).toMatchObject({ members: 2 });
    expect(await due('website')).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'power' AND job_key = ?", refKey(G))).toBe(1);
    await commit(db, [credUnit(b, pos(22), { instances: [joined(21, b, { closedAt: pos(22), closeReason: 'left' })] })], t);
    expect(await group()).toMatchObject({ members: 1 });
    expect(await due('website')).toBe(0);
    expect(await due('profile')).toBe(1);
    await commit(db, [credUnit(a, pos(23), { instances: [joined(20, a, { closedAt: pos(23), closeReason: 'left' })] })], t);
    expect(await group()).toMatchObject({ members: 0 });
    expect(await due('profile')).toBe(0);
  });

  it('keeps a profile due row fresh at one member through the stale check', async () => {
    const t = await lease();
    const a = keyCred(1);
    const anchor = { url: 'https://example.org/g.json', dataHash: 'aa'.repeat(32) };
    await commit(db, [create({ profile: anchor, profileSetAt: CREATED })], t);
    await commit(db, [credUnit(a, pos(20), { instances: [joined(20, a)] })], t);
    await db.prepare("UPDATE drep_group_due SET due_at = 0 WHERE kind = 'profile'").run();
    const page = await profilesToFetch(db, 1_000, 10, t);
    expect(page).toEqual([{ groupId: groupIdString(G), url: anchor.url, dataHash: anchor.dataHash }]);
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_due WHERE kind = 'profile'")).toBe(1);
  });

  it('writes outcomes only for tracked transactions', async () => {
    const t = await lease();
    await commit(db, [create()], t);
    await pendingRow('p1', txHashOf(30));
    const verdict = (h: number, index: number, valid: boolean) => ({
      ref: { txHash: txHashOf(h), index },
      tag: 'update' as const,
      valid,
      reason: valid ? null : 'stale seq',
      at: pos(h, 0, 2, index),
      group: G,
      subject: null,
    });
    await commit(db, [groupUnit(30, { verdicts: [verdict(30, 0, true), verdict(30, 1, false)] }), groupUnit(31, { verdicts: [verdict(31, 0, true)] })], t);
    const rows = (await db.prepare('SELECT tx_hash, idx, valid, reason, at_h FROM drep_group_own_outcomes ORDER BY idx').all<Row>()).results;
    expect(rows).toEqual([
      { tx_hash: txHashOf(30), idx: 0, valid: 1, reason: null, at_h: 30 },
      { tx_hash: txHashOf(30), idx: 1, valid: 0, reason: 'stale seq', at_h: 30 },
    ]);
    // A retried result overwrites the verdict of the same event.
    await commit(db, [groupUnit(30, { verdicts: [{ ...verdict(30, 1, false), reason: 'bad witness' }] })], t);
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_own_outcomes WHERE idx = 1 AND reason = 'bad witness'")).toBe(1);
  });

  it('marks a hosted document anchored when a version applies its hash', async () => {
    const t = await lease();
    const [mine, other] = ['a1'.repeat(32), 'b2'.repeat(32)];
    for (const h of [mine, other]) {
      await db
        .prepare("INSERT INTO drep_group_profile_docs (hash, body, created_by, created_at) VALUES (?, '{}', 'u1', 1)")
        .bind(h)
        .run();
    }
    await commit(db, [create({ profile: { url: 'https://dreptalk.test/p.json', dataHash: mine }, profileSetAt: CREATED })], t);
    const rows = (await db.prepare('SELECT hash, anchored FROM drep_group_profile_docs ORDER BY hash').all<Row>()).results;
    expect(rows).toEqual([
      { hash: mine, anchored: 1 },
      { hash: other, anchored: 0 },
    ]);
  });

  it('queues a join notification for a pending join only', async () => {
    const t = await lease();
    const [a, b] = [keyCred(1), keyCred(2)];
    await commit(db, [create()], t);
    const pending = joined(20, a, { mode: 'permissioned' });
    const open = joined(21, b);
    await commit(
      db,
      [
        credUnit(a, pos(20), { instances: [pending], effects: [{ kind: 'instanceCreated', instance: pending }] }),
        credUnit(b, pos(21), { instances: [open], effects: [{ kind: 'instanceCreated', instance: open }] }),
      ],
      t,
    );
    const rows = (await db.prepare('SELECT join_tx, join_ix, join_h FROM drep_group_join_notify').all<Row>()).results;
    expect(rows).toEqual([{ join_tx: Array.from(hashBytes(txHashOf(20))), join_ix: 0, join_h: 20 }]);
  });

  it('records policy keys for every published script', async () => {
    const t = await lease();
    const keys = [hex(1), hex(2), hex(3)];
    const m = majorityScript(keys, 2);
    const single = sigScript(hex(4));
    await commit(
      db,
      [
        groupUnit(10, {
          scripts: [
            { hash: m.hash, script: m.script, bytes: m.bytes, at: pos(10, 0, 1, -1) },
            { hash: single.hash, script: parseNativeScript(single.bytes) as NativeScript, bytes: single.bytes, at: pos(10, 0, 1, -1) },
          ],
        }),
      ],
      t,
    );
    const rows = (await db.prepare('SELECT lower(hex(key)) AS k, lower(hex(script)) AS s FROM drep_group_policy_keys ORDER BY k').all<Row>()).results;
    expect(rows).toEqual([...keys.map((k) => ({ k, s: m.hash })), { k: hex(4), s: single.hash }]);
    // Publishing the same script again writes no second row.
    await commit(db, [groupUnit(11, { scripts: [{ hash: m.hash, script: m.script, bytes: m.bytes, at: pos(11, 0, 1, -1) }] })], t);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_policy_keys')).toBe(4);
  });

  it('enqueues a power job when the open set changes at an unchanged member count', async () => {
    const t = await lease();
    const [a, b] = [keyCred(1), keyCred(2)];
    await commit(db, [create()], t);
    await commit(db, [credUnit(a, pos(20), { instances: [joined(20, a)] })], t);
    await db.prepare("DELETE FROM drep_group_jobs WHERE kind = 'power'").run();
    await commit(
      db,
      [
        credUnit(a, pos(25), { instances: [joined(20, a, { closedAt: pos(25), closeReason: 'left' })] }),
        credUnit(b, pos(26), { instances: [joined(26, b)] }),
      ],
      t,
    );
    expect(await group()).toMatchObject({ members: 1, former: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'power'")).toBe(1);
  });

  it('clears rebuilding when G reaches END(L)', async () => {
    const t = await lease();
    await db.prepare('UPDATE drep_group_meta SET L = 50, rebuilding = 1 WHERE id = 1').run();
    await commit(db, [groupUnit(40, {})], t);
    expect((await db.prepare('SELECT rebuilding FROM drep_group_meta').first<Row>())?.rebuilding).toBe(1);
    await commit(db, [{ change: emptyChange(), cursor: { kind: 'group', G: endOf(50) } }], t);
    const meta = await db.prepare('SELECT * FROM drep_group_meta').first<Row>();
    expect(meta).toMatchObject({ rebuilding: 0, G_h: 50, G_tx: [] });
  });

  it('writes tooDeep display json for a deep member script', async () => {
    const t = await lease();
    const c: Credential = { kind: 'script', hash: 'ab'.repeat(28) };
    const { bytes, script } = deepScript(5000);
    await commit(db, [credUnit(c, certPos(10), { memberScripts: [{ credential: c, script, bytes, at: certPos(10) }] })], t);
    const row = await db.prepare('SELECT display_json, length(bytes) AS n FROM drep_group_member_scripts WHERE cred = ?').bind(cb(c)).first<Row>();
    expect(row).toEqual({ display_json: '{"type":"tooDeep"}', n: bytes.length });
  });

  it('rejects a commit with a stale lease and writes nothing', async () => {
    const t = await lease();
    await commit(db, [create()], t);
    await db.prepare('UPDATE drep_group_lease SET expires_at = 0').run();
    const tables = ['drep_group_versions', 'drep_groups', 'drep_group_instances', 'drep_group_jobs'];
    const counts = async () => Promise.all(tables.map((x) => count(`SELECT COUNT(*) AS n FROM ${x}`)));
    const before = await counts();
    await expect(
      commit(
        db,
        [
          groupUnit(30, {
            versions: [version(G, CREATED, pos(30), { seq: 1n, status: 'dissolved' })],
          }),
          credUnit(keyCred(1), pos(20), { instances: [joined(20, keyCred(1))] }),
        ],
        t,
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await counts()).toEqual(before);
    await expect(commit(db, [], t)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('recomputes next after a credential cursor', async () => {
    const t = await lease();
    const a = keyCred(1);
    await track(a, 1);
    await labelTx(10);
    const entry = {
      subject: a,
      at: pos(10),
      group: G,
      txHash: txHashOf(10),
      event: { ok: true as const, event: { tag: 'join' as const, group: G, member: a } },
    };
    await commit(
      db,
      [
        groupUnit(10, {
          queued: [entry],
          txContexts: [{ txHash: txHashOf(10), context: { signers: [], requiredSigners: [], invalidBefore: null, invalidHereafter: 5n } }],
        }),
      ],
      t,
    );
    expect(posOrNull(await tracked(a), 'next')).toEqual(pos(10));
    await ledger(a, 'reg', 20);
    await commit(db, [credUnit(a, pos(10), { appliedQueue: [join(10)] })], t);
    expect(posOrNull(await tracked(a), 'next')).toEqual(certPos(20));
    expect(await count('SELECT applied AS n FROM drep_group_queue WHERE tx_hash = ?', hashBytes(txHashOf(10)))).toBe(1);
    await commit(db, [credUnit(a, certPos(20), {})], t);
    expect(posOrNull(await tracked(a), 'next')).toBeNull();
    expect(posOrNull(await tracked(a), 'applied')).toEqual(certPos(20));
  });
});

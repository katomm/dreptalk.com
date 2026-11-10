/// <reference types="@cloudflare/workers-types" />
// The join notification drain, end to end through the phase and over seeded engine state.
import { env } from 'cloudflare:test';
import type { Credential } from 'drep-groups';
import { credKey, hexToBytes, majorityScript } from 'drep-groups';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { countingDb } from '../sync/queryBudget.js';
import { type Chain, ev, type FakeReg, type FakeTx, fakeKoios, K, payloadValue, sigScript, T, txCbor } from './__tests__/fixtures.js';
import type { Cbor } from './__tests__/loadFixtures.js';
import { credBytes, hashBytes, MAX, type Row } from './codec.js';
import { drepIdForCredential, groupIdString } from './ids.js';
import { drainJoinNotifications } from './joinNotify.js';
import { runDrepGroupsPhase } from './phase.js';
import { acquireLease, invocationOwner } from './store/lease.js';

const db = env.DB;

const all = async (sql: string, ...binds: unknown[]): Promise<Row[]> => (await db.prepare(sql).bind(...binds).all<Row>()).results ?? [];
const count = async (sql: string, ...binds: unknown[]): Promise<number> => Number((await all(sql, ...binds))[0]?.n);
const queuedRows = (): Promise<number> => count('SELECT COUNT(*) AS n FROM drep_group_join_notify');
const joinNotifications = (): Promise<Row[]> =>
  all("SELECT recipient_id, event_key, payload FROM notifications WHERE type = 'group_join_request' ORDER BY recipient_id");

const CONTROL = K(1);
const control = sigScript(CONTROL);
const [A1, A2] = [K(0xa1), K(0xa2)];
const admission = majorityScript([A1, A2], 1);
const M = K(0x50);
const credM: Credential = { kind: 'key', hash: M };
const regM: FakeReg = { drepId: drepIdForCredential(credM), action: 'registered', hash: T(0x40), height: 50, index: 0 };
const keyDrep = (k: string): string => drepIdForCredential({ kind: 'key', hash: k });
/** A permissioned create with its admission policy. Every listed key signs a create. */
const createPermissioned: Cbor = [0, 1, hexToBytes(control.hash), hexToBytes(admission.hash)];
const scripts = [control.bytes, admission.bytes];
const group = { txHash: T(1), index: 0 };

const create: FakeTx = {
  hash: T(1),
  height: 100,
  index: 0,
  cbor: txCbor({ payload: payloadValue([createPermissioned], scripts), requiredSigners: [CONTROL, A1, A2] }),
};
const join: FakeTx = {
  hash: T(2),
  height: 101,
  index: 0,
  cbor: txCbor({ payload: payloadValue([ev.join(group, M)]), requiredSigners: [M] }),
};
const founding: FakeTx = {
  hash: T(1),
  height: 100,
  index: 0,
  // The founder joins and is approved in the founding tx.
  cbor: txCbor({ payload: payloadValue([createPermissioned, ev.join(0, M), [4, [1]]], scripts), requiredSigners: [CONTROL, A1, A2, M] }),
};

async function user(id: string, drepId: string): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, drep_id, is_drep, role, status, created_at, last_verified_at) VALUES (?, ?, 1, 'member', 'active', 1, 1)")
    .bind(id, drepId)
    .run();
}

async function seedAdmins(): Promise<void> {
  await user('admin1', keyDrep(A1));
  await user('admin2', keyDrep(A2));
  await user('bystander', keyDrep(K(0xee)));
  await db
    .prepare("INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at, name) VALUES (?, 'registered', 1, 0, 0, 'Carol')")
    .bind(drepIdForCredential(credM))
    .run();
}

const phase = (chain: Chain) =>
  runDrepGroupsPhase({
    db,
    koios: fakeKoios(chain),
    meter: countingDb(db).meter,
    gateway: null,
    network: 'preprod',
    now: 1_000,
    fetchImpl: vi.fn() as unknown as typeof fetch,
  });

describe('join notifications through the phase', () => {
  it('notifies admission keys for a join still pending after its tx', async () => {
    await seedAdmins();
    await phase({ tip: 200, txs: [create, join], regs: [regM] });
    const rows = await joinNotifications();
    expect(rows.map((r) => r.recipient_id)).toEqual(['admin1', 'admin2']);
    expect(rows.every((r) => r.event_key === `group-join:${T(2)}#0`)).toBe(true);
    expect(JSON.parse(String(rows[0].payload))).toEqual({ groupId: groupIdString(group), groupName: null, memberName: 'Carol' });
    expect(await queuedRows()).toBe(0);
  });

  it('leaves out an admission key that resigned from admission', async () => {
    await seedAdmins();
    const resign: FakeTx = { hash: T(3), height: 100, index: 1, cbor: txCbor({ payload: payloadValue([ev.resign(group, A1)]), requiredSigners: [A1] }) };
    await phase({ tip: 200, txs: [create, resign, join], regs: [regM] });
    expect((await joinNotifications()).map((r) => r.recipient_id)).toEqual(['admin2']);
    expect(await queuedRows()).toBe(0);
  });

  it('sends nothing for a founding join approved in the same tx', async () => {
    await seedAdmins();
    await phase({ tip: 200, txs: [founding], regs: [regM] });
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_instances WHERE approved_h IS NOT NULL")).toBe(1);
    expect(await joinNotifications()).toEqual([]);
    expect(await queuedRows()).toBe(0);
  });

  it('inserts nothing for a repeated join notification after truncation and does not fail the batch', async () => {
    await seedAdmins();
    const chain: Chain = { tip: 200, txs: [create, join], regs: [regM] };
    await phase(chain);
    expect(await joinNotifications()).toHaveLength(2);
    await db.prepare('UPDATE drep_group_meta SET operator_truncate = 100 WHERE id = 1').run();
    let replayed = false;
    for (let i = 0; i < 6; i++) {
      // The drain hands the replayed join to the insert again, which writes nothing for a known event key.
      if ((await phase(chain)).joins.sent > 0) replayed = true;
      const meta = (await all('SELECT rec_first_kind FROM drep_group_meta WHERE id = 1'))[0];
      if (meta.rec_first_kind === null && (await count('SELECT COUNT(*) AS n FROM drep_group_instances')) === 1) break;
    }
    // The join was replayed after the truncation and drained again without a second notification.
    expect(replayed).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_instances WHERE approved_h IS NULL')).toBe(1);
    expect(await queuedRows()).toBe(0);
    expect(await joinNotifications()).toHaveLength(2);
  });
});

// Seeded engine state for the drain alone.
const JOIN_TX = T(0x700);
const GROUP_TX = T(0x600);

async function seedState(o: { applied: number; approved: boolean }): Promise<void> {
  const g = hashBytes(GROUP_TX);
  const j = hashBytes(JOIN_TX);
  await db
    .prepare(
      `INSERT INTO drep_group_scripts (hash, at_h, at_ti, at_ph, at_ix, at_tx, bytes) VALUES (?, 90, 0, 1, -1, ?, ?)`,
    )
    .bind(hashBytes(admission.hash), g, admission.bytes)
    .run();
  await db
    .prepare(
      `INSERT INTO drep_groups (group_tx, group_ix, cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, admission, seq, status,
         created_h, created_ti, created_ph, created_ix, created_tx, members)
       VALUES (?1, 0, 90, 0, 2, 0, ?1, 'permissioned', ?2, ?3, '0', 'active', 90, 0, 2, 0, ?1, 1)`,
    )
    .bind(g, hashBytes(control.hash), hashBytes(admission.hash))
    .run();
  await db
    .prepare('INSERT INTO drep_group_txs (tx_hash, block_height, block_hash, tx_index, marker) VALUES (?, 100, ?, 0, 0)')
    .bind(j, hashBytes(T(0xb100)))
    .run();
  await db.prepare('UPDATE drep_group_meta SET G_h = 100, G_ti = 0, G_ph = 2, G_ix = ?, G_tx = ? WHERE id = 1').bind(MAX, j).run();
  await db
    .prepare(
      `INSERT INTO drep_group_instances (join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode, joined_h, joined_ti, joined_ph,
         joined_ix, joined_tx, approved_h, approved_ti, approved_ph, approved_ix, approved_tx, counted_as)
       VALUES (?1, 1, ?2, 0, ?3, ?4, 'permissioned', 100, 0, 2, 1, ?1, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      j,
      g,
      credBytes(credKey(credM)),
      drepIdForCredential(credM),
      ...(o.approved ? [100, 0, 2, 2, j] : [null, null, null, null, null]),
      o.approved ? 'open' : 'pending',
    )
    .run();
  await db.prepare('INSERT INTO drep_group_join_notify (join_tx, join_ix, join_h) VALUES (?, 1, 100)').bind(j).run();
  // The approval of the same tx waits in the member's queue.
  await db
    .prepare(
      `INSERT INTO drep_group_queue (tx_hash, idx, subject, at_h, at_ti, at_ph, at_ix, at_tx, event_json, applied)
       VALUES (?1, 2, ?2, 100, 0, 2, 2, ?1, '{}', 0)`,
    )
    .bind(j, credBytes(credKey(credM)))
    .run();
  await db
    .prepare(
      `INSERT INTO drep_group_tracked (cred, seq, known, history_done, applied_h, applied_ti, applied_ph, applied_ix, applied_tx)
       VALUES (?, 1, 1, 1, 100, 0, 2, ?, ?)`,
    )
    .bind(credBytes(credKey(credM)), o.applied, j)
    .run();
}

describe('drainJoinNotifications', () => {
  let lease: string;
  beforeEach(async () => {
    lease = (await acquireLease(db, invocationOwner())) as string;
    await seedAdmins();
  });

  it('keeps a founding join queued while the approval in the same tx is not processed', async () => {
    // The credential budget ended after the join, before the approval.
    await seedState({ applied: 1, approved: false });
    expect(await drainJoinNotifications(db, lease, 1_000)).toEqual({ sent: 0 });
    expect(await queuedRows()).toBe(1);
    expect(await joinNotifications()).toEqual([]);
    // The next tick applied the approval.
    await db.prepare('UPDATE drep_group_tracked SET applied_ix = 2').run();
    await db
      .prepare('UPDATE drep_group_instances SET approved_h = 100, approved_ti = 0, approved_ph = 2, approved_ix = 2, approved_tx = join_tx')
      .run();
    expect(await drainJoinNotifications(db, lease, 1_000)).toEqual({ sent: 0 });
    expect(await queuedRows()).toBe(0);
    expect(await joinNotifications()).toEqual([]);
  });

  it('notifies once the join tx is processed and the join is still pending', async () => {
    await seedState({ applied: 2, approved: false });
    expect(await drainJoinNotifications(db, lease, 1_000)).toEqual({ sent: 2 });
    expect((await joinNotifications()).map((r) => r.recipient_id)).toEqual(['admin1', 'admin2']);
    expect(await queuedRows()).toBe(0);
  });

  it('deletes a join notify row whose instance is gone', async () => {
    await db.prepare('INSERT INTO drep_group_join_notify (join_tx, join_ix, join_h) VALUES (?, 0, 100)').bind(hashBytes(T(0x7ff))).run();
    expect(await drainJoinNotifications(db, lease, 1_000)).toEqual({ sent: 0 });
    expect(await queuedRows()).toBe(0);
    expect(await joinNotifications()).toEqual([]);
  });

  it('keeps the row when the notification insert fails', async () => {
    await seedState({ applied: 2, approved: false });
    const failing = new WeakSet<D1PreparedStatement>();
    const wrapped = {
      prepare: (sql: string) => {
        const st = db.prepare(sql);
        if (!sql.includes('INSERT INTO notifications')) return st;
        const bind = st.bind.bind(st);
        st.bind = (...args: unknown[]) => {
          const bound = bind(...args);
          failing.add(bound);
          return bound;
        };
        return st;
      },
      batch: <T = unknown>(stmts: D1PreparedStatement[]) => {
        if (stmts.some((s) => failing.has(s))) return Promise.reject(new Error('notifications down'));
        return db.batch<T>(stmts);
      },
    } as unknown as D1Database;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await drainJoinNotifications(wrapped, lease, 1_000)).toEqual({ sent: 0 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    expect(await queuedRows()).toBe(1);
    expect(await drainJoinNotifications(db, lease, 1_000)).toEqual({ sent: 2 });
    expect(await queuedRows()).toBe(0);
  });
});

/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { loadDelegation } from './loadDelegation.js';
import { upsertVotes, recordLocalVote } from './drepVotes.js';

const db = () => env.DB as D1Database;

/** Minimal resolved (or pending) delegator_follows row, matching the migration
 *  0062 CHECK constraint: a resolved row needs delegation_type + checked_at +
 *  delegation_set_at set (drep_id only for delegation_type = 'drep'). */
async function insertFollow(
  userId: string,
  stakeAddr: string,
  opts: { status?: string; type?: string | null; drepId?: string | null } = {},
) {
  const resolved = (opts.status ?? 'resolved') === 'resolved';
  await db()
    .prepare(
      `INSERT INTO delegator_follows
         (user_id, stake_addr, resolution_status, delegation_type, drep_id, checked_at, delegation_set_at, refresh_attempted_at, refresh_error_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      userId, stakeAddr, opts.status ?? 'resolved', opts.type ?? null, opts.drepId ?? null,
      resolved ? 100 : null, resolved ? 100 : null, resolved ? 100 : null,
    )
    .run();
}

/** Minimal valid dreps row (only the NOT NULL columns without defaults). */
async function seedDrep(drepId: string, name = 'Test DRep') {
  await db()
    .prepare(`INSERT INTO dreps (drep_id, status, active, name, last_synced_at, created_at) VALUES (?, 'active', 1, ?, 0, 0)`)
    .bind(drepId, name)
    .run();
}

/** Governance action, decided (for history) or active (votable). */
async function seedAction(o: { id: string; status: string; decidedEpoch?: number | null; expiryEpoch?: number | null }) {
  await db()
    .prepare(
      `INSERT INTO governance_actions (id, type, title, status, decided_epoch, expiry_epoch, topic_id, created_at, last_synced_at)
       VALUES (?, 'InfoAction', ?, ?, ?, ?, NULL, 0, 0)`,
    )
    .bind(o.id, `Test action ${o.id}`, o.status, o.decidedEpoch ?? null, o.expiryEpoch ?? null)
    .run();
}

describe('loadDelegation', () => {
  it('(a) resolved drep-follow: 1 confirmed history vote + 1 unvoted active action', async () => {
    await insertFollow('userA', 'stake_a', { type: 'drep', drepId: 'drepA' });
    await seedDrep('drepA');
    await seedAction({ id: 'gaHistA', status: 'enacted', decidedEpoch: 500 });
    await upsertVotes(db(), 'gaHistA', [{ voterRole: 'DRep', voterId: 'drepA', voterHex: null, vote: 'Yes', blockTime: 1000 }], 1);
    await seedAction({ id: 'gaOpenA', status: 'active', expiryEpoch: 600 });

    const data = await loadDelegation(db(), 'userA');
    expect(data.view).toEqual({ kind: 'drep', drepId: 'drepA', staleError: false });
    expect(data.drep?.drepId).toBe('drepA');
    expect(data.history).toHaveLength(1);
    expect(data.history[0].ga_id).toBe('gaHistA');
    expect(data.openActions).toHaveLength(1);
    expect(data.openActions[0].id).toBe('gaOpenA');
    expect(data.openActions[0].viewerVote).toBeNull();
  });

  it('(b) a CONFIRMED vote on the active action removes it from openActions', async () => {
    await insertFollow('userB', 'stake_b', { type: 'drep', drepId: 'drepB' });
    await seedDrep('drepB');
    await seedAction({ id: 'gaOpenB', status: 'active', expiryEpoch: 600 });
    await upsertVotes(db(), 'gaOpenB', [{ voterRole: 'DRep', voterId: 'drepB', voterHex: null, vote: 'Yes', blockTime: 1000 }], 1);

    const data = await loadDelegation(db(), 'userB');
    expect(data.openActions).toHaveLength(0);
    expect(data.history).toHaveLength(1); // the confirmed vote shows up as history too
  });

  it('(c) an optimistic pending self-cast on the active action stays open and is excluded from history', async () => {
    await insertFollow('userC', 'stake_c', { type: 'drep', drepId: 'drepC' });
    await seedDrep('drepC');
    await seedAction({ id: 'gaOpenC', status: 'active', expiryEpoch: 600 });
    await recordLocalVote(db(), { gaId: 'gaOpenC', drepId: 'drepC', voterHex: null, vote: 'yes', metaUrl: null, txHash: 'txc', now: 1000 });

    const data = await loadDelegation(db(), 'userC');
    expect(data.openActions).toHaveLength(1);
    expect(data.openActions[0].id).toBe('gaOpenC');
    expect(data.openActions[0].viewerVote).toBe('yes');
    expect(data.openActions[0].viewerStatus).toBe('pending');
    expect(data.history).toHaveLength(0); // confirmedOnly excludes the pending self-cast
  });

  it('(d) resolved abstain-follow runs no drep queries', async () => {
    await insertFollow('userD', 'stake_d', { type: 'abstain', drepId: null });

    const data = await loadDelegation(db(), 'userD');
    expect(data.view).toEqual({ kind: 'abstain', staleError: false });
    expect(data.drep).toBeNull();
    expect(data.history).toEqual([]);
    expect(data.openActions).toEqual([]);
  });

  it('(e) no follow row: everything empty', async () => {
    const data = await loadDelegation(db(), 'userE-does-not-exist');
    expect(data.view).toEqual({ kind: 'no-follow' });
    expect(data.drep).toBeNull();
    expect(data.history).toEqual([]);
    expect(data.openActions).toEqual([]);
    expect(data.earlier.size).toBe(0);
  });

  it('(f) drep-follow whose drep_id has no dreps row: drep null, but history/openActions still reflect the seeded data', async () => {
    await insertFollow('userF', 'stake_f', { type: 'drep', drepId: 'drepF-unsynced' });
    // Deliberately no seedDrep() call: drepF-unsynced has no dreps row.
    await seedAction({ id: 'gaHistF', status: 'enacted', decidedEpoch: 500 });
    await upsertVotes(db(), 'gaHistF', [{ voterRole: 'DRep', voterId: 'drepF-unsynced', voterHex: null, vote: 'No', blockTime: 1000 }], 1);
    await seedAction({ id: 'gaOpenF', status: 'active', expiryEpoch: 600 });

    const data = await loadDelegation(db(), 'userF');
    expect(data.view).toEqual({ kind: 'drep', drepId: 'drepF-unsynced', staleError: false });
    expect(data.drep).toBeNull();
    expect(data.history).toHaveLength(1);
    expect(data.history[0].ga_id).toBe('gaHistF');
    expect(data.history[0].vote).toBe('No');
    expect(data.openActions).toHaveLength(1);
    expect(data.openActions[0].id).toBe('gaOpenF');
    expect(data.openActions[0].viewerVote).toBeNull();
  });
});

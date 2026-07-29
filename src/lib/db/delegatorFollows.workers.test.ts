/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

const db = () => env.DB as D1Database;

async function insertFollow(
  userId: string,
  stakeAddr: string,
  opts: { status?: string; type?: string | null; drepId?: string | null } = {},
) {
  const resolved = opts.status === 'resolved';
  await db()
    .prepare(
      `INSERT INTO delegator_follows
         (user_id, stake_addr, resolution_status, delegation_type, drep_id, checked_at, delegation_set_at, refresh_attempted_at, refresh_error_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(userId, stakeAddr, opts.status ?? 'pending', opts.type ?? null, opts.drepId ?? null,
      resolved ? 100 : null, resolved ? 100 : null, resolved ? 100 : null)
    .run();
}

describe('delegator_follows schema (migration 0062)', () => {
  it('accepts a pending row with null delegation fields', async () => {
    await expect(insertFollow('u-pending', 'stake_test1a')).resolves.toBeUndefined();
  });
  it('accepts a resolved drep row and rejects resolved with null drep_id', async () => {
    await expect(insertFollow('u-drep', 'stake_test1b', { status: 'resolved', type: 'drep', drepId: 'drep1x' })).resolves.toBeUndefined();
    await expect(insertFollow('u-bad', 'stake_test1c', { status: 'resolved', type: 'drep', drepId: null })).rejects.toThrow();
  });
  it('rejects a resolved non-drep row that carries a drep_id', async () => {
    await expect(insertFollow('u-bad2', 'stake_test1d', { status: 'resolved', type: 'abstain', drepId: 'drep1y' })).rejects.toThrow();
  });
  it('enforces unique stake_addr across follows', async () => {
    await insertFollow('u-uniq-1', 'stake_test1dup');
    await expect(insertFollow('u-uniq-2', 'stake_test1dup')).rejects.toThrow();
  });
});

describe('notifications event_key index (migration 0062)', () => {
  const ins = (recipient: string, key: string, id: string) =>
    db().prepare(
      `INSERT INTO notifications (id, recipient_id, type, event_key, created_at)
       VALUES (?, ?, 'delegation_changed', ?, 0)
       ON CONFLICT(recipient_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    ).bind(id, recipient, key).run();

  it('dedups same recipient + same event_key', async () => {
    await ins('r1', 'k1', 'n1');
    await ins('r1', 'k1', 'n2');
    const row = await db().prepare("SELECT COUNT(*) AS c FROM notifications WHERE recipient_id='r1'").first<{ c: number }>();
    expect(row?.c).toBe(1);
  });
  it('allows a different recipient with the same event_key (needed for Phase 4 fan-out)', async () => {
    await ins('r2', 'shared', 'n3');
    await ins('r3', 'shared', 'n4');
    const row = await db().prepare("SELECT COUNT(*) AS c FROM notifications WHERE event_key='shared'").first<{ c: number }>();
    expect(row?.c).toBe(2);
  });
});

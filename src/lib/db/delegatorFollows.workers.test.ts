/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getFollow, ensureFollow, applyResolution, markBatchError } from './delegatorFollows.js';
import { getNotificationsPage } from './notifications.js';

const db = () => env.DB as D1Database;

const drepState = (id: string) => ({ status: 'resolved' as const, state: { type: 'drep' as const, drepId: id } });

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

describe('delegatorFollows module', () => {
  it('ensureFollow creates a pending row and is idempotent; throws on a stake_addr mismatch', async () => {
    await ensureFollow(db(), 'm1', 'stake_test1m1', 1000);
    await ensureFollow(db(), 'm1', 'stake_test1m1', 2000); // idempotent
    expect((await getFollow(db(), 'm1'))?.resolution_status).toBe('pending');
    await expect(ensureFollow(db(), 'm1', 'stake_test1OTHER', 3000)).rejects.toThrow();
  });

  it('sets the baseline without an event, then fires exactly one event with a payload on a real change', async () => {
    await ensureFollow(db(), 'm2', 'stake_test1m2', 1000);
    expect(await applyResolution(db(), 'm2', drepState('drep1a'), 1000)).toBe('created');
    expect((await getNotificationsPage(db(), 'm2', 10)).length).toBe(0);

    expect(await applyResolution(db(), 'm2', drepState('drep1a'), 2000)).toBe('unchanged');
    expect((await getNotificationsPage(db(), 'm2', 10)).length).toBe(0);

    expect(await applyResolution(db(), 'm2', drepState('drep1b'), 3000)).toBe('changed');
    const notes = await getNotificationsPage(db(), 'm2', 10);
    expect(notes.length).toBe(1);
    expect(notes[0].type).toBe('delegation_changed');
    const payload = JSON.parse(notes[0].payload as string);
    expect(payload.from).toEqual({ type: 'drep', drepId: 'drep1a' });
    expect(payload.to).toEqual({ type: 'drep', drepId: 'drep1b' });
  });

  it('an error outcome only records refresh_error_at, never touches the baseline or fires', async () => {
    await ensureFollow(db(), 'm3', 'stake_test1m3', 1000);
    await applyResolution(db(), 'm3', { status: 'resolved', state: { type: 'none' } }, 1000);
    expect(await applyResolution(db(), 'm3', { status: 'error' }, 2000)).toBe('error');
    const row = await getFollow(db(), 'm3');
    expect(row?.delegation_type).toBe('none');
    expect(row?.refresh_error_at).toBe(2000);
    expect(row?.refresh_attempted_at).toBe(2000);
    expect((await getNotificationsPage(db(), 'm3', 10)).length).toBe(0);
  });

  it('a later success clears refresh_error_at without an event when unchanged', async () => {
    await ensureFollow(db(), 'm4', 'stake_test1m4', 1000);
    await applyResolution(db(), 'm4', { status: 'resolved', state: { type: 'none' } }, 1000);
    await applyResolution(db(), 'm4', { status: 'error' }, 2000);
    expect(await applyResolution(db(), 'm4', { status: 'resolved', state: { type: 'none' } }, 3000)).toBe('unchanged');
    expect((await getFollow(db(), 'm4'))?.refresh_error_at).toBeNull();
  });

  it('markBatchError sets attempt + error for every id', async () => {
    await ensureFollow(db(), 'm5', 'stake_test1m5', 1000);
    await ensureFollow(db(), 'm6', 'stake_test1m6', 1000);
    await markBatchError(db(), ['m5', 'm6'], 5000);
    expect((await getFollow(db(), 'm5'))?.refresh_error_at).toBe(5000);
    expect((await getFollow(db(), 'm6'))?.refresh_attempted_at).toBe(5000);
  });
});

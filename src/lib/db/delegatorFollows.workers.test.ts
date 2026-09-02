/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getFollow, ensureFollow, applyResolution, markBatchError, getFollowedDrepIds, setDelegatedSince, captureDelegatedSince, listFollowsMissingSince } from './delegatorFollows.js';
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

  it('getFollowedDrepIds returns only the distinct drep ids of resolved-drep follows', async () => {
    await insertFollow('gf-drep-a', 'stake_test1gfa', { status: 'resolved', type: 'drep', drepId: 'drep1gfA' });
    await insertFollow('gf-pending', 'stake_test1gfp');
    await insertFollow('gf-abstain', 'stake_test1gfb', { status: 'resolved', type: 'abstain' });
    await insertFollow('gf-drep-b', 'stake_test1gfc', { status: 'resolved', type: 'drep', drepId: 'drep1gfB' });

    const ids = await getFollowedDrepIds(db());
    expect(ids.size).toBe(2);
    expect(ids.has('drep1gfA')).toBe(true);
    expect(ids.has('drep1gfB')).toBe(true);
  });
});

describe('delegation start columns (migration 0089)', () => {
  const since = async (userId: string) =>
    db().prepare('SELECT delegated_since_epoch, since_checked_at FROM delegator_follows WHERE user_id = ?')
      .bind(userId).first<{ delegated_since_epoch: number | null; since_checked_at: number | null }>();

  it('starts NULL on a fresh follow', async () => {
    await ensureFollow(db(), 's1', 'stake_test1s1', 1000);
    const row = await since('s1');
    expect(row?.delegated_since_epoch).toBeNull();
    expect(row?.since_checked_at).toBeNull();
  });

  it('setDelegatedSince stores the epoch and the attempt time', async () => {
    await ensureFollow(db(), 's2', 'stake_test1s2', 1000);
    await setDelegatedSince(db(), 's2', 655, 4000);
    expect(await since('s2')).toEqual({ delegated_since_epoch: 655, since_checked_at: 4000 });
  });

  it('setDelegatedSince with a null epoch records the attempt and clears a stale start', async () => {
    await ensureFollow(db(), 's3', 'stake_test1s3', 1000);
    await setDelegatedSince(db(), 's3', 655, 4000);
    await setDelegatedSince(db(), 's3', null, 9000);
    expect(await since('s3')).toEqual({ delegated_since_epoch: null, since_checked_at: 9000 });
  });

  it('listFollowsMissingSince returns only the missing and stale rows, stalest first, capped', async () => {
    await ensureFollow(db(), 'ls-a', 'stake_test1lsa', 0);
    await ensureFollow(db(), 'ls-b', 'stake_test1lsb', 0);
    await ensureFollow(db(), 'ls-c', 'stake_test1lsc', 0);
    await ensureFollow(db(), 'ls-d', 'stake_test1lsd', 0);
    await setDelegatedSince(db(), 'ls-a', 640, 100); // has a start, never a candidate
    await setDelegatedSince(db(), 'ls-b', null, 500); // attempted, stale against 1000
    await setDelegatedSince(db(), 'ls-c', null, 300); // attempted, staler
    // ls-d was never attempted, since_checked_at IS NULL sorts first

    const ids = ['ls-a', 'ls-b', 'ls-c', 'ls-d'];
    expect(await listFollowsMissingSince(db(), ids, 1000, 10)).toEqual([
      { userId: 'ls-d', stakeAddr: 'stake_test1lsd', sinceCheckedAt: null },
      { userId: 'ls-c', stakeAddr: 'stake_test1lsc', sinceCheckedAt: 300 },
      { userId: 'ls-b', stakeAddr: 'stake_test1lsb', sinceCheckedAt: 500 },
    ]);
    expect(await listFollowsMissingSince(db(), ids, 1000, 2)).toEqual([
      { userId: 'ls-d', stakeAddr: 'stake_test1lsd', sinceCheckedAt: null },
      { userId: 'ls-c', stakeAddr: 'stake_test1lsc', sinceCheckedAt: 300 },
    ]);
  });

  it('listFollowsMissingSince skips rows attempted at or after staleBefore and rows outside the id list', async () => {
    await ensureFollow(db(), 'lf-fresh', 'stake_test1lff', 0);
    await ensureFollow(db(), 'lf-other', 'stake_test1lfo', 0);
    await setDelegatedSince(db(), 'lf-fresh', null, 1000);
    expect(await listFollowsMissingSince(db(), ['lf-fresh'], 1000, 10)).toEqual([]);
    expect(await listFollowsMissingSince(db(), ['lf-fresh'], 1001, 10))
      .toEqual([{ userId: 'lf-fresh', stakeAddr: 'stake_test1lff', sinceCheckedAt: 1000 }]);
    expect(await listFollowsMissingSince(db(), [], 9999, 10)).toEqual([]);
  });

  it('captureDelegatedSince writes only while the row still matches what was observed', async () => {
    await ensureFollow(db(), 'cas-1', 'stake_test1cas1', 0);
    await ensureFollow(db(), 'cas-2', 'stake_test1cas2', 0);
    await ensureFollow(db(), 'cas-3', 'stake_test1cas3', 0);

    // Observed never attempted, still never attempted: the write applies.
    expect(await captureDelegatedSince(db(), 'cas-1', 640, 4000, null)).toBe(true);
    expect(await since('cas-1')).toEqual({ delegated_since_epoch: 640, since_checked_at: 4000 });

    // Observed never attempted, but a start was captured in between: refused.
    await setDelegatedSince(db(), 'cas-2', 700, 3000);
    expect(await captureDelegatedSince(db(), 'cas-2', 640, 4000, null)).toBe(false);
    expect(await since('cas-2')).toEqual({ delegated_since_epoch: 700, since_checked_at: 3000 });

    // Observed at 300, but a failed attempt moved the stamp on: refused, so the
    // newer attempt window stands.
    await setDelegatedSince(db(), 'cas-3', null, 300);
    await setDelegatedSince(db(), 'cas-3', null, 3500);
    expect(await captureDelegatedSince(db(), 'cas-3', 640, 4000, 300)).toBe(false);
    expect(await since('cas-3')).toEqual({ delegated_since_epoch: null, since_checked_at: 3500 });
    // Observing the current stamp lets it through.
    expect(await captureDelegatedSince(db(), 'cas-3', 640, 4000, 3500)).toBe(true);
    expect(await since('cas-3')).toEqual({ delegated_since_epoch: 640, since_checked_at: 4000 });
  });

  it('counts the attempts that found no start and resets the run on a captured one', async () => {
    const attempts = async (userId: string) =>
      (await db().prepare('SELECT since_attempts FROM delegator_follows WHERE user_id = ?')
        .bind(userId).first<{ since_attempts: number }>())?.since_attempts;

    await ensureFollow(db(), 'at-1', 'stake_test1at1', 0);
    expect(await attempts('at-1')).toBe(0);

    await setDelegatedSince(db(), 'at-1', null, 1000);
    expect(await attempts('at-1')).toBe(1);
    await setDelegatedSince(db(), 'at-1', null, 2000);
    expect(await attempts('at-1')).toBe(2);
    // The compare-and-set path counts the same way.
    expect(await captureDelegatedSince(db(), 'at-1', null, 3000, 2000)).toBe(true);
    expect(await attempts('at-1')).toBe(3);
    // A refused compare-and-set writes nothing, so it counts nothing either.
    expect(await captureDelegatedSince(db(), 'at-1', null, 4000, 2000)).toBe(false);
    expect(await attempts('at-1')).toBe(3);

    // A captured start ends the run.
    expect(await captureDelegatedSince(db(), 'at-1', 640, 5000, 3000)).toBe(true);
    expect(await attempts('at-1')).toBe(0);

    // And so does setDelegatedSince with an epoch.
    await ensureFollow(db(), 'at-2', 'stake_test1at2', 0);
    await setDelegatedSince(db(), 'at-2', null, 1000);
    await setDelegatedSince(db(), 'at-2', 655, 2000);
    expect(await attempts('at-2')).toBe(0);
  });

  it('a failed lookup records the attempt time but does not count toward giving up', async () => {
    const attempts = async (userId: string) =>
      (await db().prepare('SELECT since_attempts FROM delegator_follows WHERE user_id = ?')
        .bind(userId).first<{ since_attempts: number }>())?.since_attempts;

    await ensureFollow(db(), 'fl-1', 'stake_test1fl1', 0);

    // A failed setDelegatedSince (fresh baseline path) stamps the check time
    // but leaves the run at 0.
    await setDelegatedSince(db(), 'fl-1', null, 1000, true);
    expect(await since('fl-1')).toEqual({ delegated_since_epoch: null, since_checked_at: 1000 });
    expect(await attempts('fl-1')).toBe(0);

    // A confirmed-empty lookup right after does increment, so the two are
    // genuinely distinguished, not just always-zero.
    await setDelegatedSince(db(), 'fl-1', null, 2000);
    expect(await attempts('fl-1')).toBe(1);

    // A failed captureDelegatedSince (retry path) behaves the same way: the
    // stamp moves on, the run does not.
    await ensureFollow(db(), 'fl-2', 'stake_test1fl2', 0);
    expect(await captureDelegatedSince(db(), 'fl-2', null, 1000, null, true)).toBe(true);
    expect(await since('fl-2')).toEqual({ delegated_since_epoch: null, since_checked_at: 1000 });
    expect(await attempts('fl-2')).toBe(0);
    expect(await captureDelegatedSince(db(), 'fl-2', null, 2000, 1000, true)).toBe(true);
    expect(await attempts('fl-2')).toBe(0);
    // A confirmed-empty capture on the same row does increment.
    expect(await captureDelegatedSince(db(), 'fl-2', null, 3000, 2000)).toBe(true);
    expect(await attempts('fl-2')).toBe(1);
  });

  it('a changed delegation resets the attempt count with the start it belonged to', async () => {
    await ensureFollow(db(), 'at-3', 'stake_test1at3', 1000);
    await applyResolution(db(), 'at-3', drepState('drep1ata'), 1000);
    await setDelegatedSince(db(), 'at-3', null, 1000);
    await setDelegatedSince(db(), 'at-3', null, 2000);
    await setDelegatedSince(db(), 'at-3', null, 3000);

    expect(await applyResolution(db(), 'at-3', drepState('drep1atb'), 4000)).toBe('changed');
    const row = await getFollow(db(), 'at-3');
    expect(row?.since_attempts).toBe(0);
    expect(row?.delegated_since_epoch).toBeNull();
  });

  it('a changed delegation clears the captured start so both capture paths pick it up', async () => {
    await ensureFollow(db(), 'ch-1', 'stake_test1ch1', 1000);
    await applyResolution(db(), 'ch-1', drepState('drep1cha'), 1000);
    await setDelegatedSince(db(), 'ch-1', 640, 1000);
    expect(await since('ch-1')).toEqual({ delegated_since_epoch: 640, since_checked_at: 1000 });

    expect(await applyResolution(db(), 'ch-1', drepState('drep1chb'), 2000)).toBe('changed');
    expect(await since('ch-1')).toEqual({ delegated_since_epoch: null, since_checked_at: null });
    expect(await listFollowsMissingSince(db(), ['ch-1'], 2000, 10))
      .toEqual([{ userId: 'ch-1', stakeAddr: 'stake_test1ch1', sinceCheckedAt: null }]);

    // An unchanged re-resolution leaves a captured start alone.
    await setDelegatedSince(db(), 'ch-1', 655, 2000);
    expect(await applyResolution(db(), 'ch-1', drepState('drep1chb'), 3000)).toBe('unchanged');
    expect(await since('ch-1')).toEqual({ delegated_since_epoch: 655, since_checked_at: 2000 });
  });
});

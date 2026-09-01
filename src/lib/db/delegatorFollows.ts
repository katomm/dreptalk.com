/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for delegator_follows plus atomic delegation-change
// detection. Every outcome is derived from the write result (meta.changes), not
// from a pre-read that could go stale under a concurrent refresh. All queries use
// prepare().bind(); never string-concatenated SQL.
import type { DelegationState } from '../delegation/resolve.js';
import { sqlPlaceholders } from './sql.js';

export type ResolutionOutcome = { status: 'resolved'; state: DelegationState } | { status: 'error' };

export interface DelegatorFollowRow {
  user_id: string;
  stake_addr: string;
  resolution_status: 'pending' | 'resolved';
  delegation_type: string | null;
  drep_id: string | null;
  checked_at: number | null;
  delegation_set_at: number | null;
  refresh_attempted_at: number | null;
  refresh_error_at: number | null;
  delegated_since_epoch: number | null;
  since_checked_at: number | null;
}

function columnsFor(state: DelegationState): { type: string; drepId: string | null } {
  return state.type === 'drep' ? { type: 'drep', drepId: state.drepId } : { type: state.type, drepId: null };
}

/** Reconstructs a DelegationState from a resolved row for the notification payload. */
function stateOf(row: DelegatorFollowRow | null): DelegationState | null {
  if (row?.resolution_status !== 'resolved' || !row.delegation_type) return null;
  if (row.delegation_type === 'drep') return { type: 'drep', drepId: row.drep_id! };
  return { type: row.delegation_type as 'abstain' | 'no_confidence' | 'none' };
}

export async function getFollow(db: D1Database, userId: string): Promise<DelegatorFollowRow | null> {
  return db.prepare('SELECT * FROM delegator_follows WHERE user_id = ?').bind(userId).first<DelegatorFollowRow>();
}

/**
 * Ensures a pending tracking row exists for this account. Idempotent for the same
 * stake address. Throws on a stake_addr mismatch (a row already tracks a DIFFERENT
 * address for this user_id): that is an internal inconsistency, not an upstream
 * error, so the caller must NOT swallow it fail-soft.
 */
// `_now` is unused today: the CHECK constraint requires checked_at/delegation_set_at
// to be NULL while pending, so there is nowhere to store a creation timestamp yet.
// Kept in the signature for interface symmetry with applyResolution/markBatchError
// and in case a future migration adds a created_at column.
export async function ensureFollow(db: D1Database, userId: string, stakeAddr: string, _now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO delegator_follows
         (user_id, stake_addr, resolution_status, delegation_type, drep_id, checked_at, delegation_set_at, refresh_attempted_at, refresh_error_at)
       VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(user_id) DO NOTHING`,
    )
    .bind(userId, stakeAddr)
    .run();
  const row = await getFollow(db, userId);
  if (row && row.stake_addr !== stakeAddr) {
    throw new Error(`ensureFollow: user ${userId} already tracks a different stake address`);
  }
}

/**
 * Applies a resolution outcome. Advances refresh_attempted_at on every call.
 *  - error: set refresh_error_at + attempted only; baseline untouched; no event.
 *  - first success (from pending): set the baseline atomically (WHERE pending);
 *    no event.
 *  - resolved that differs from the baseline: atomic conditional INSERT (gated by
 *    the change predicate, ON CONFLICT on the event_key index) + UPDATE with the
 *    same predicate, in one db.batch (INSERT first). The result is read from the
 *    UPDATE's meta.changes, not from the pre-read.
 *  - resolved equal to the baseline: advance checked_at, clear error.
 */
export async function applyResolution(
  db: D1Database,
  userId: string,
  outcome: ResolutionOutcome,
  now: number,
): Promise<'created' | 'changed' | 'unchanged' | 'error'> {
  if (outcome.status === 'error') {
    await db.prepare('UPDATE delegator_follows SET refresh_error_at = ?, refresh_attempted_at = ? WHERE user_id = ?')
      .bind(now, now, userId).run();
    return 'error';
  }

  const { type, drepId } = columnsFor(outcome.state);

  // 1. Try to set the baseline atomically (only from pending). One writer wins.
  const base = await db
    .prepare(
      `UPDATE delegator_follows
          SET resolution_status = 'resolved', delegation_type = ?, drep_id = ?,
              checked_at = ?, delegation_set_at = ?, refresh_attempted_at = ?, refresh_error_at = NULL
        WHERE user_id = ? AND resolution_status = 'pending'`,
    )
    .bind(type, drepId, now, now, now, userId)
    .run();
  if ((base.meta.changes ?? 0) > 0) return 'created';

  // Baseline already exists. Read the old state for the payload (display best-effort).
  const existing = await getFollow(db, userId);
  const from = stateOf(existing);

  // 2. Conditional change: INSERT the event (gated) then UPDATE (same predicate).
  // NOTE: notifications.created_at is UNIX MILLISECONDS (migration 0053 seeds
  // notif_seen_at with strftime('%s')*1000 and the inbox compares to Date.now());
  // `now` here is unix SECONDS (the follow-row unit), so the notification row
  // uses now*1000. Mixing the two would date the row at 1970 and mis-sort it.
  const eventKey = `deleg-change:${userId}:${now}`;
  const createdAtMs = now * 1000;
  const payload = JSON.stringify({ from, to: outcome.state });
  const pred = "resolution_status = 'resolved' AND (delegation_type != ? OR COALESCE(drep_id,'') != COALESCE(?, ''))";
  const results = await db.batch([
    db.prepare(
      `INSERT INTO notifications (id, recipient_id, type, event_key, payload, created_at)
       SELECT ?, user_id, 'delegation_changed', ?, ?, ?
         FROM delegator_follows WHERE user_id = ? AND ${pred}
       ON CONFLICT(recipient_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    ).bind(crypto.randomUUID(), eventKey, payload, createdAtMs, userId, type, drepId),
    db.prepare(
      `UPDATE delegator_follows
          SET delegation_type = ?, drep_id = ?, delegation_set_at = ?, checked_at = ?, refresh_attempted_at = ?, refresh_error_at = NULL
        WHERE user_id = ? AND ${pred}`,
    ).bind(type, drepId, now, now, now, userId, type, drepId),
  ]);
  if ((results[1].meta.changes ?? 0) > 0) return 'changed';

  // 3. No change: advance checked_at + attempted, clear any error.
  await db
    .prepare(
      `UPDATE delegator_follows SET checked_at = ?, refresh_attempted_at = ?, refresh_error_at = NULL
        WHERE user_id = ? AND resolution_status = 'resolved'`,
    )
    .bind(now, now, userId)
    .run();
  return 'unchanged';
}

/**
 * Returns the distinct set of DRep ids that have at least one resolved follower
 * delegating to them. Used by the cron fan-out to skip DReps with no followers to
 * notify.
 */
export async function getFollowedDrepIds(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT drep_id FROM delegator_follows
        WHERE resolution_status = 'resolved' AND delegation_type = 'drep' AND drep_id IS NOT NULL`,
    )
    .all<{ drep_id: string }>();
  return new Set(results.map((row) => row.drep_id));
}

/**
 * Records a delegation-start capture attempt. `epoch` null means the attempt ran
 * but produced no start (Koios failed, or the account has no delegation_drep
 * event), so the row keeps a NULL start and waits out the retry window instead
 * of being re-queried on every login.
 */
export async function setDelegatedSince(
  db: D1Database,
  userId: string,
  epoch: number | null,
  now: number,
): Promise<void> {
  await db
    .prepare('UPDATE delegator_follows SET delegated_since_epoch = ?, since_checked_at = ? WHERE user_id = ?')
    .bind(epoch, now, userId)
    .run();
}

/**
 * The follows among `userIds` that still need a start captured: no start yet and
 * either never attempted or last attempted before `staleBefore` (unix seconds).
 * Stalest first (never-attempted rows sort first, COALESCE to 0), capped at
 * `limit` so one bulk pass stays within a single Koios chunk.
 * The id list is chunked because D1 caps a statement at 100 bound parameters,
 * so each chunk is ordered and capped in SQL and the merged result is ordered
 * and capped again in JS.
 */
export async function listFollowsMissingSince(
  db: D1Database,
  userIds: string[],
  staleBefore: number,
  limit: number,
): Promise<{ userId: string; stakeAddr: string }[]> {
  if (userIds.length === 0 || limit <= 0) return [];
  const found: { userId: string; stakeAddr: string; checkedAt: number }[] = [];
  for (let i = 0; i < userIds.length; i += 90) {
    const chunk = userIds.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT user_id, stake_addr, COALESCE(since_checked_at, 0) AS since_order
           FROM delegator_follows
          WHERE user_id IN (${sqlPlaceholders(chunk)})
            AND delegated_since_epoch IS NULL
            AND (since_checked_at IS NULL OR since_checked_at < ?)
          ORDER BY since_order, user_id
          LIMIT ?`,
      )
      .bind(...chunk, staleBefore, limit)
      .all<{ user_id: string; stake_addr: string; since_order: number }>();
    for (const row of results) {
      found.push({ userId: row.user_id, stakeAddr: row.stake_addr, checkedAt: row.since_order });
    }
  }
  found.sort((a, b) => a.checkedAt - b.checkedAt || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return found.slice(0, limit).map(({ userId, stakeAddr }) => ({ userId, stakeAddr }));
}

/** Marks a whole failed bulk batch: attempt + error, so rows wait the due window and errors are visible. */
export async function markBatchError(db: D1Database, userIds: string[], now: number): Promise<void> {
  for (let i = 0; i < userIds.length; i += 40) {
    const chunk = userIds.slice(i, i + 40);
    await db
      .prepare(`UPDATE delegator_follows SET refresh_attempted_at = ?, refresh_error_at = ? WHERE user_id IN (${sqlPlaceholders(chunk)})`)
      .bind(now, now, ...chunk)
      .run();
  }
}

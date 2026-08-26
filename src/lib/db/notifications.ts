/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the notifications table (personal notifications
// only; broadcast gov events are merged from the activity table at read time).
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.

export interface NotificationInsert {
  recipientId: string;
  // device_paired is a security notice: no actor, topic or post, and it is not
  // subject to per-channel preferences.
  type:
    | 'reply'
    | 'mention'
    | 'device_paired'
    | 'delegation_changed'
    | 'delegator_drep_voted'
    | 'delegator_drep_re_voted'
    | 'delegator_drep_status_changed'
    // drep_stats rows are written by drepStatsDigest.ts with payload + event_key.
    | 'drep_stats'
    // rationale_ready rows are written by drepVotes.ts (upsertVotes) with
    // payload + event_key when a pending self-cast with a rationale confirms.
    | 'rationale_ready';
  actorId: string | null;
  topicId: string | null;
  postId: string | null;
  createdAt: number;
}

export interface NotificationRow {
  id: string;
  recipient_id: string;
  type: string;
  actor_id: string | null;
  topic_id: string | null;
  post_id: string | null;
  payload: string | null;
  created_at: number;
  read_at: number | null;
}

// 7 binds per row; 14 rows keep a statement under D1's 100-bind-param limit
// (miniflare does not enforce the limit, so tests alone would not catch this).
const INSERT_CHUNK = 14;

/**
 * Inserts personal notification rows, chunked under the bind-param limit.
 * All chunks go through one db.batch call, so a big fan-out costs a single
 * round trip instead of one per chunk.
 */
export async function insertNotifications(db: D1Database, rows: NotificationInsert[]): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    statements.push(
      db
        .prepare(
          `INSERT INTO notifications (id, recipient_id, type, actor_id, topic_id, post_id, created_at)
           VALUES ${values}`,
        )
        .bind(
          ...chunk.flatMap((r) => [
            crypto.randomUUID(),
            r.recipientId,
            r.type,
            r.actorId,
            r.topicId,
            r.postId,
            r.createdAt,
          ]),
        ),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

/** The recipient's personal notifications, newest first. */
export async function getNotificationsPage(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<NotificationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, recipient_id, type, actor_id, topic_id, post_id, payload, created_at, read_at
       FROM notifications
       WHERE recipient_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<NotificationRow>();
  return results;
}

/**
 * Shared SQL term: distinct live governance threads with activity newer than
 * the given cursor expression. The single definition of what counts as a
 * governance notification (event types, live-topic join, per-thread collapse),
 * used by the header badge (getUnreadCount, seen cursor) and the push
 * dispatcher (getPendingCounts, delivery cursor) so the two can never
 * silently diverge. cursorExpr must be a bind placeholder or a subquery over
 * bound values, never user data.
 *
 * Compares notified_at (detection time), not created_at (the on-chain
 * submission time, which predates discovery): a governance action is dated at
 * submission for the feed, but for notifications it is "new" when we discovered
 * it. Using created_at here silently dropped every back-dated action that
 * landed before the cursor (migration 0067).
 *
 * The comparison is on the bare column, never COALESCE(notified_at, created_at):
 * an expression over the column is not sargable, so the wrapped form cannot use
 * idx_activity_notified and makes this scan all of activity on a per-render path
 * (the header badge). No fallback is needed, since migration 0067 backfilled
 * every existing row and both insert paths always bind a value.
 */
export function govThreadsSinceSql(cursorExpr: string): string {
  return `(SELECT COUNT(DISTINCT a.topic_id) FROM activity a
            JOIN topics t ON t.id = a.topic_id
            WHERE a.type IN ('gov_created', 'gov_status')
              AND t.deleted = 0
              AND a.notified_at > ${cursorExpr})`;
}

/**
 * Unread badge count: unread personal rows plus distinct live governance
 * threads with an unseen event, newer than the user's notif_seen_at cursor.
 * The gov term counts DISTINCT topic_id (not raw event rows) and joins
 * topics to exclude deleted ones, matching loadActivityFeed's one-row-per-thread
 * collapse in getActivityPage (src/lib/db/activity.ts) so the badge and the
 * inbox agree. One statement, evaluated per page render for signed-in writers
 * only. Counting activity rows here (instead of going through db/activity.ts)
 * is a deliberate exception: it keeps the badge to a single query on a
 * per-page-render path. A missing users row yields a NULL cursor, and
 * SQLite's `created_at > NULL` comparison evaluates to NULL (falsy), so the
 * gov term contributes 0; this relies on intentional SQL NULL semantics, not
 * on an explicit COALESCE. Accepts an undefined db (like loadAuthorIdentity)
 * so layout callers need no guard of their own.
 */
export async function getUnreadCount(db: D1Database | undefined, userId: string): Promise<number> {
  if (!db) return 0;
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND read_at IS NULL)
         +
         ${govThreadsSinceSql('(SELECT notif_seen_at FROM users WHERE id = ?1)')} AS n`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The broadcast read cursor; 0 when the user row is missing. */
export async function getNotifSeenAt(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT notif_seen_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ notif_seen_at: number }>();
  return row?.notif_seen_at ?? 0;
}

/** Marks all personal rows read and advances the broadcast cursor, atomically. */
export async function markAllRead(db: D1Database, userId: string, now: number): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL')
      .bind(now, userId),
    db.prepare('UPDATE users SET notif_seen_at = ? WHERE id = ?').bind(now, userId),
  ]);
}

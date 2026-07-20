/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the notifications table (personal notifications
// only; broadcast gov events are merged from the activity table at read time).
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.

import { sqlPlaceholders } from './sql.js';

export interface NotificationInsert {
  recipientId: string;
  type: 'reply' | 'mention';
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

/** Inserts personal notification rows, chunked under the bind-param limit. */
export async function insertNotifications(db: D1Database, rows: NotificationInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    await db
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
      )
      .run();
  }
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
 * Unread badge count: unread personal rows plus broadcast gov events newer
 * than the user's notif_seen_at cursor. One statement, evaluated per page
 * render for signed-in writers only. A missing users row yields a NULL cursor,
 * which the comparison treats as "no gov events", so the result stays 0.
 */
export async function getUnreadCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND read_at IS NULL)
         +
         (SELECT COUNT(*) FROM activity
            WHERE type IN ('gov_created', 'gov_status')
              AND created_at > (SELECT notif_seen_at FROM users WHERE id = ?1)) AS n`,
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

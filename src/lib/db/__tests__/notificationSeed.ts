/// <reference types="@cloudflare/workers-types" />
// Test-only seeding helpers for notification-related tables: rows and cursor
// values the production write paths do not expose directly (an explicit
// created_at, or an unconditional cursor set), needed by tests that must
// control timestamps relative to a fixed pass window.

/** Sets a channel's delivery cursor unconditionally. Test seeding only; production hands a claim back through handBackChannelCursor. */
export async function setChannelCursor(db: D1Database, id: string, deliveredUntil: number): Promise<void> {
  await db.prepare('UPDATE notification_channels SET delivered_until = ? WHERE id = ?').bind(deliveredUntil, id).run();
}

export interface SeedNotificationRowOpts {
  recipientId: string;
  type: string;
  createdAt: number;
  actorId?: string | null;
  topicId?: string | null;
  postId?: string | null;
  payload?: unknown;
}

/** Inserts a notifications row with an explicit created_at, since insertNotifications no longer accepts one (created_at now comes from the database clock) and tests that count or resolve pending work need a controlled time relative to a fixed cursor. */
export async function seedNotificationRow(db: D1Database, opts: SeedNotificationRowOpts): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications (id, recipient_id, type, actor_id, topic_id, post_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      opts.recipientId,
      opts.type,
      opts.actorId ?? null,
      opts.topicId ?? null,
      opts.postId ?? null,
      opts.payload === undefined ? null : JSON.stringify(opts.payload),
      opts.createdAt,
    )
    .run();
}

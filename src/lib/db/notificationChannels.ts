/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for notification_channels and notification_prefs
// (migration 0054). All queries use .prepare().bind() exclusively; never
// string-concatenated SQL.

export const NOTIFICATION_EVENT_TYPES = ['reply', 'mention', 'governance'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type NotificationChannelKind = 'webpush';

export interface NotificationChannelRow {
  id: string;
  user_id: string;
  channel: string;
  target: string;
  created_at: number;
  delivered_until: number;
}

/**
 * Connects a new channel and seeds all-enabled prefs rows for the channel
 * kind (INSERT OR IGNORE, so an already-customized pref for another channel
 * row of the same kind is left untouched). Returns the new channel's id.
 */
export async function addChannel(
  db: D1Database,
  args: { userId: string; channel: NotificationChannelKind; target: string; now: number },
): Promise<string> {
  const id = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO notification_channels (id, user_id, channel, target, created_at, delivered_until)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, args.userId, args.channel, args.target, args.now, args.now),
    ...NOTIFICATION_EVENT_TYPES.map((eventType) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO notification_prefs (user_id, channel, event_type, enabled)
           VALUES (?, ?, ?, 1)`,
        )
        .bind(args.userId, args.channel, eventType),
    ),
  ];
  await db.batch(statements);
  return id;
}

/** Removes a channel, scoped to its owning user. */
export async function removeChannel(db: D1Database, userId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM notification_channels WHERE id = ? AND user_id = ?').bind(id, userId).run();
}

/** The connected channels for one user. */
export async function listChannels(db: D1Database, userId: string): Promise<NotificationChannelRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, channel, target, created_at, delivered_until
       FROM notification_channels
       WHERE user_id = ?`,
    )
    .bind(userId)
    .all<NotificationChannelRow>();
  return results;
}

/** All channels of one kind, across users; the dispatcher's per-run scan. */
export async function listChannelsByKind(
  db: D1Database,
  channel: NotificationChannelKind,
): Promise<NotificationChannelRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, channel, target, created_at, delivered_until
       FROM notification_channels
       WHERE channel = ?`,
    )
    .bind(channel)
    .all<NotificationChannelRow>();
  return results;
}

/** Removes a channel by id regardless of owner; dispatcher prune on 404/410. */
export async function deleteChannelById(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM notification_channels WHERE id = ?').bind(id).run();
}

/** Advances the delivery cursor after a successful send. */
export async function advanceCursor(db: D1Database, id: string, deliveredUntil: number): Promise<void> {
  await db.prepare('UPDATE notification_channels SET delivered_until = ? WHERE id = ?').bind(deliveredUntil, id).run();
}

/** Per-event-type prefs for one user/channel; a missing row counts as enabled. */
export async function getPrefs(
  db: D1Database,
  userId: string,
  channel: string,
): Promise<Record<NotificationEventType, boolean>> {
  const { results } = await db
    .prepare('SELECT event_type, enabled FROM notification_prefs WHERE user_id = ? AND channel = ?')
    .bind(userId, channel)
    .all<{ event_type: string; enabled: number }>();
  const stored = new Map(results.map((r) => [r.event_type, r.enabled === 1]));
  return Object.fromEntries(
    NOTIFICATION_EVENT_TYPES.map((eventType) => [eventType, stored.get(eventType) ?? true]),
  ) as Record<NotificationEventType, boolean>;
}

/** Sets one event-type pref for a user/channel. */
export async function setPref(
  db: D1Database,
  args: { userId: string; channel: string; eventType: NotificationEventType; enabled: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO notification_prefs (user_id, channel, event_type, enabled)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(args.userId, args.channel, args.eventType, args.enabled ? 1 : 0)
    .run();
}

/** Pending work for one channel row since its cursor, already prefs-filtered. */
export interface PendingCounts {
  replies: number;
  mentions: number;
  governance: number;
  total: number;
}

/**
 * Counts undelivered work for one channel row: personal reply/mention
 * notifications and distinct live governance threads with activity, all
 * newer than the row's delivered_until cursor. The gov term mirrors
 * getUnreadCount's DISTINCT topic_id collapse and live-topic join (see
 * src/lib/db/notifications.ts), but keys off the channel's delivery cursor
 * instead of the user's notif_seen_at. Each term is zeroed when its pref
 * is off, so a disabled event type never contributes to the total.
 */
export async function getPendingCounts(
  db: D1Database,
  row: NotificationChannelRow,
  prefs: Record<NotificationEventType, boolean>,
): Promise<PendingCounts> {
  const result = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'reply' AND created_at > ?2) AS replies,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'mention' AND created_at > ?2) AS mentions,
         (SELECT COUNT(DISTINCT a.topic_id) FROM activity a
            JOIN topics t ON t.id = a.topic_id
            WHERE a.type IN ('gov_created', 'gov_status')
              AND t.deleted = 0
              AND a.created_at > ?2) AS governance`,
    )
    .bind(row.user_id, row.delivered_until)
    .first<{ replies: number; mentions: number; governance: number }>();

  const replies = prefs.reply ? (result?.replies ?? 0) : 0;
  const mentions = prefs.mention ? (result?.mentions ?? 0) : 0;
  const governance = prefs.governance ? (result?.governance ?? 0) : 0;
  return { replies, mentions, governance, total: replies + mentions + governance };
}

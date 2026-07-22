/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for notification_channels and notification_prefs
// (migration 0054). All queries use .prepare().bind() exclusively; never
// string-concatenated SQL.

import { govThreadsSinceSql } from './notifications.js';

export const NOTIFICATION_EVENT_TYPES = ['reply', 'mention', 'governance'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type NotificationChannelKind = 'webpush' | 'telegram';

export interface NotificationChannelRow {
  id: string;
  user_id: string;
  channel: string;
  target: string;
  endpoint: string;
  label: string | null;
  created_at: number;
  delivered_until: number;
}

/**
 * Connects a channel and seeds all-enabled prefs rows for the channel kind
 * (INSERT OR IGNORE, so an already-customized pref for another channel row
 * of the same kind is left untouched). Deduped on (user_id, endpoint): a
 * repeat subscribe from an already-connected device updates the stored
 * target (keys may rotate) and returns the existing row's id instead of
 * creating a duplicate.
 */
export async function addChannel(
  db: D1Database,
  args: {
    userId: string;
    channel: NotificationChannelKind;
    target: string;
    endpoint: string;
    label?: string | null;
    now: number;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO notification_channels (id, user_id, channel, target, endpoint, label, created_at, delivered_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, endpoint) DO UPDATE SET target = excluded.target, label = excluded.label
         RETURNING id`,
      )
      .bind(id, args.userId, args.channel, args.target, args.endpoint, args.label ?? null, args.now, args.now),
    ...NOTIFICATION_EVENT_TYPES.map((eventType) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO notification_prefs (user_id, channel, event_type, enabled)
           VALUES (?, ?, ?, 1)`,
        )
        .bind(args.userId, args.channel, eventType),
    ),
  ];
  const [insertResult] = await db.batch<{ id: string }>(statements);
  return insertResult.results[0].id;
}

/** Removes a channel, scoped to its owning user. */
export async function removeChannel(db: D1Database, userId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM notification_channels WHERE id = ? AND user_id = ?').bind(id, userId).run();
}

/** The connected channels for one user. */
export async function listChannels(db: D1Database, userId: string): Promise<NotificationChannelRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, channel, target, endpoint, label, created_at, delivered_until
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
      `SELECT id, user_id, channel, target, endpoint, label, created_at, delivered_until
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

/**
 * Removes every channel row with the given endpoint, across users (a /stop in
 * a Telegram chat must disconnect the chat no matter which account linked it).
 * Returns the number of rows removed.
 */
export async function deleteChannelsByEndpoint(db: D1Database, endpoint: string): Promise<number> {
  const result = await db.prepare('DELETE FROM notification_channels WHERE endpoint = ?').bind(endpoint).run();
  return result.meta.changes ?? 0;
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
 * newer than the row's delivered_until cursor. The gov term is the shared
 * govThreadsSinceSql fragment (same definition the header badge uses), keyed
 * off the channel's delivery cursor instead of the user's notif_seen_at.
 * Each term is zeroed when its pref is off, so a disabled event type never
 * contributes to the total.
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
         ${govThreadsSinceSql('?2')} AS governance`,
    )
    .bind(row.user_id, row.delivered_until)
    .first<{ replies: number; mentions: number; governance: number }>();

  const replies = prefs.reply ? (result?.replies ?? 0) : 0;
  const mentions = prefs.mention ? (result?.mentions ?? 0) : 0;
  const governance = prefs.governance ? (result?.governance ?? 0) : 0;
  return { replies, mentions, governance, total: replies + mentions + governance };
}

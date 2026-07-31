/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for notification_channels and notification_prefs
// (migration 0054). All queries use .prepare().bind() exclusively; never
// string-concatenated SQL.

import { govThreadsSinceSql } from './notifications.js';

export const NOTIFICATION_EVENT_TYPES = [
  'reply',
  'mention',
  'governance',
  'drep_activity',
  'drep_status',
  'my_delegation',
] as const;
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

/** Sets the delivery cursor unconditionally; used to hand a claim back on failure. */
export async function setChannelCursor(db: D1Database, id: string, deliveredUntil: number): Promise<void> {
  await db.prepare('UPDATE notification_channels SET delivered_until = ? WHERE id = ?').bind(deliveredUntil, id).run();
}

/**
 * Claims a channel's pending bundle by advancing its cursor, but only while the
 * row still holds the value this run read. The governance cron fires every five
 * minutes and a heavy run can outlast that, so two invocations can sit in the
 * dispatch loop at once; both would read the same delivered_until and send the
 * same bundle. Only one conditional UPDATE can match, so the loser gets false
 * and skips the channel. Callers must claim BEFORE sending and hand the claim
 * back (setChannelCursor to the old value) when delivery does not succeed.
 */
export async function claimChannelCursor(
  db: D1Database,
  id: string,
  expected: number,
  deliveredUntil: number,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE notification_channels SET delivered_until = ? WHERE id = ? AND delivered_until = ?')
    .bind(deliveredUntil, id, expected)
    .run();
  return (res.meta.changes ?? 0) > 0;
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
  drepActivity: number;
  drepStatus: number;
  myDelegation: number;
  /** Security notices; deliberately not prefs-filtered, unlike the others. */
  devices: number;
  total: number;
}

/**
 * Counts undelivered work for one channel row: personal reply/mention
 * notifications, distinct live governance threads with activity, delegator
 * fan-out notifications (drep vote activity, drep status changes, and the
 * user's own delegation changes), all newer than the row's delivered_until
 * cursor. The gov term is the shared govThreadsSinceSql fragment (same
 * definition the header badge uses), keyed off the channel's delivery cursor
 * instead of the user's notif_seen_at. Each term is zeroed when its pref is
 * off, except device_paired: a security alert that can be switched off is
 * worthless, so it always contributes.
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
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'device_paired' AND created_at > ?2) AS devices,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type IN ('delegator_drep_voted', 'delegator_drep_re_voted') AND created_at > ?2) AS drepActivity,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'delegator_drep_status_changed' AND created_at > ?2) AS drepStatus,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'delegation_changed' AND created_at > ?2) AS myDelegation,
         ${govThreadsSinceSql('?2')} AS governance`,
    )
    .bind(row.user_id, row.delivered_until)
    .first<{
      replies: number;
      mentions: number;
      governance: number;
      devices: number;
      drepActivity: number;
      drepStatus: number;
      myDelegation: number;
    }>();

  const replies = prefs.reply ? (result?.replies ?? 0) : 0;
  const mentions = prefs.mention ? (result?.mentions ?? 0) : 0;
  const governance = prefs.governance ? (result?.governance ?? 0) : 0;
  const drepActivity = prefs.drep_activity ? (result?.drepActivity ?? 0) : 0;
  const drepStatus = prefs.drep_status ? (result?.drepStatus ?? 0) : 0;
  const myDelegation = prefs.my_delegation ? (result?.myDelegation ?? 0) : 0;
  // Security notices are deliberately not gated on prefs: an alert that can be
  // switched off is worthless, so a device pairing always contributes.
  const devices = result?.devices ?? 0;
  return {
    replies,
    mentions,
    governance,
    drepActivity,
    drepStatus,
    myDelegation,
    devices,
    total: replies + mentions + governance + drepActivity + drepStatus + myDelegation + devices,
  };
}

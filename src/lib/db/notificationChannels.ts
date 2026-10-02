/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for notification_channels and notification_prefs
// (migration 0054). All queries use .prepare().bind() exclusively; never
// string-concatenated SQL.

import { govThreadsSinceSql } from './notifications.js';
import { DB_NOW_MS } from './sql.js';

export const NOTIFICATION_EVENT_TYPES = [
  'reply',
  'mention',
  'governance',
  'drep_activity',
  'drep_status',
  'my_delegation',
  'drep_stats',
  'rationale_ready',
  'governance_review',
  'delegation_digest',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/**
 * Event types a channel only receives after an explicit opt-in. The epoch
 * summary repeats the per-vote DRep notifications, which are on by default,
 * so push and Telegram stay quiet about it unless asked.
 */
const OPT_IN_EVENT_TYPES: ReadonlySet<NotificationEventType> = new Set(['delegation_digest']);

/** The pref a channel has for an event type it never stored a choice for. */
export function prefDefault(eventType: NotificationEventType): boolean {
  return !OPT_IN_EVENT_TYPES.has(eventType);
}
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
  /** Unix ms of the last successful send, or null if none yet. Never set by the muted/nothing-to-send path. */
  last_sent_at: number | null;
}

/**
 * Connects a channel and seeds default prefs rows (prefDefault) for the channel kind
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
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO notification_channels (id, user_id, channel, target, endpoint, label, created_at, delivered_until)
         VALUES (?, ?, ?, ?, ?, ?, ${DB_NOW_MS}, ${DB_NOW_MS})
         ON CONFLICT(user_id, endpoint) DO UPDATE SET target = excluded.target, label = excluded.label
         RETURNING id`,
      )
      .bind(id, args.userId, args.channel, args.target, args.endpoint, args.label ?? null),
    ...NOTIFICATION_EVENT_TYPES.map((eventType) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO notification_prefs (user_id, channel, event_type, enabled)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(args.userId, args.channel, eventType, prefDefault(eventType) ? 1 : 0),
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
      `SELECT id, user_id, channel, target, endpoint, label, created_at, delivered_until, last_sent_at
       FROM notification_channels
       WHERE user_id = ?`,
    )
    .bind(userId)
    .all<NotificationChannelRow>();
  return results;
}

/** What a dispatch pass reads once before touching any channel. */
export interface PassStart {
  /** The database clock at pass start (DB_NOW_MS). The pass works on ts <= dbNow - 1. */
  dbNow: number;
  /** Newest notified_at of a live governance thread event, or null when there is none. */
  latestGovAt: number | null;
}

/**
 * One query at the start of a dispatch pass: the database clock that bounds the
 * pass interval, and the newest live governance event for the candidate query.
 */
export async function readPassStart(db: D1Database): Promise<PassStart> {
  const row = await db
    .prepare(
      `SELECT ${DB_NOW_MS} AS db_now,
              (SELECT MAX(a.notified_at) FROM activity a JOIN topics t ON t.id = a.topic_id
                WHERE a.type IN ('gov_created', 'gov_status') AND t.deleted = 0) AS latest_gov_at`,
    )
    .first<{ db_now: number; latest_gov_at: number | null }>();
  if (!row) throw new Error('pass start read returned no row');
  return { dbNow: row.db_now, latestGovAt: row.latest_gov_at };
}

/**
 * Channels of one kind that may have something to deliver, least recently
 * attempted first. A superset of "has pending work": prefs are ignored here and
 * applied by getPendingCounts. A channel qualifies when a live governance
 * thread is newer than its cursor or it has any personal row newer than it.
 * A null latestGovAt makes `delivered_until < NULL` NULL, which drops the
 * governance term.
 */
export async function listDispatchCandidates(
  db: D1Database,
  kind: NotificationChannelKind,
  latestGovAt: number | null,
  limit: number,
): Promise<NotificationChannelRow[]> {
  if (limit <= 0) return [];
  const { results } = await db
    .prepare(
      `SELECT id, user_id, channel, target, endpoint, label, created_at, delivered_until, last_sent_at
         FROM notification_channels c
        WHERE c.channel = ?1
          AND (c.delivered_until < ?2
               OR EXISTS (SELECT 1 FROM notifications n
                           WHERE n.recipient_id = c.user_id AND n.created_at > c.delivered_until))
        ORDER BY c.dispatch_attempted_at, c.id
        LIMIT ?3`,
    )
    .bind(kind, latestGovAt, limit)
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

/**
 * Claims a channel's pending bundle by advancing its cursor, but only while the
 * row still holds the value this run read. The notifications cron fires every
 * five minutes and a slow run can outlast that, so two invocations can sit in
 * the dispatch loop at once. Both would read the same delivered_until and send
 * the same bundle. Only one conditional UPDATE can match, so the loser gets
 * false and skips the channel. Callers must claim BEFORE sending and hand the
 * claim back (handBackChannelCursor) when delivery does not succeed.
 *
 * The same UPDATE stamps dispatch_attempted_at, the rotation key of
 * listDispatchCandidates. A handback restores only delivered_until and leaves
 * the stamp, so a failing channel still moves to the back of the rotation.
 */
export async function claimChannelCursor(
  db: D1Database,
  id: string,
  expected: number,
  deliveredUntil: number,
  attemptedAt: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      'UPDATE notification_channels SET delivered_until = ?, dispatch_attempted_at = ? WHERE id = ? AND delivered_until = ?',
    )
    .bind(deliveredUntil, attemptedAt, id, expected)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Restores a channel's cursor after a claim did not lead to a successful send,
 * but only while the row still holds the value this pass claimed. A slow pass
 * can fail after a later pass already claimed and sent the next bundle. An
 * unconditional handback would then rewind that later pass's cursor and its
 * bundle would go out again. When the row no longer holds `claimedValue`
 * (another pass already moved it on), this is a no-op.
 */
export async function handBackChannelCursor(
  db: D1Database,
  id: string,
  claimedValue: number,
  restoreTo: number,
): Promise<void> {
  await db
    .prepare('UPDATE notification_channels SET delivered_until = ? WHERE id = ? AND delivered_until = ?')
    .bind(restoreTo, id, claimedValue)
    .run();
}

/** Sets last_sent_at to the database clock; called only after a confirmed successful send. */
export async function markChannelSent(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE notification_channels SET last_sent_at = ${DB_NOW_MS} WHERE id = ?`).bind(id).run();
}

/** Per-event-type prefs for one user/channel. A missing row takes the type's default (prefDefault). */
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
    NOTIFICATION_EVENT_TYPES.map((eventType) => [eventType, stored.get(eventType) ?? prefDefault(eventType)]),
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
  /** DRep stats epoch digests (the user's own DRep). */
  drepStats: number;
  /** Delegator epoch digests about the user's DRep. */
  delegationDigest: number;
  /** The user's own vote rationale confirmed on chain and ready to share. */
  rationaleReady: number;
  /** New Governance Review editions. */
  reviews: number;
  /** Security notices; deliberately not prefs-filtered, unlike the others. */
  devices: number;
  total: number;
}

/**
 * Counts undelivered work for one channel row: personal reply/mention
 * notifications, distinct live governance threads with activity, delegator
 * fan-out notifications (drep vote activity, drep status changes, and the
 * user's own delegation changes), the delegator's epoch digests, the user's own DRep stats epoch digests,
 * the user's own shareable vote rationales, new Governance Review editions,
 * all inside the pass interval delivered_until < ts <= passEnd (see
 * readPassStart: rows written after the pass started wait for the next pass,
 * so the claim never moves the cursor past a row this count did not see).
 * The gov term is the shared govThreadsSinceSql fragment (same definition
 * the header badge uses), keyed off the channel's delivery cursor instead of
 * the user's notif_seen_at. Each term is zeroed when its pref is off, except
 * device_paired: a security alert that can be switched off is worthless, so
 * it always contributes.
 */
export async function getPendingCounts(
  db: D1Database,
  row: NotificationChannelRow,
  prefs: Record<NotificationEventType, boolean>,
  passEnd: number,
): Promise<PendingCounts> {
  const result = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'reply' AND created_at > ?2 AND created_at <= ?3) AS replies,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'mention' AND created_at > ?2 AND created_at <= ?3) AS mentions,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'device_paired' AND created_at > ?2 AND created_at <= ?3) AS devices,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type IN ('delegator_drep_voted', 'delegator_drep_re_voted') AND created_at > ?2 AND created_at <= ?3) AS drepActivity,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'delegator_drep_status_changed' AND created_at > ?2 AND created_at <= ?3) AS drepStatus,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'delegation_changed' AND created_at > ?2 AND created_at <= ?3) AS myDelegation,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'drep_stats' AND created_at > ?2 AND created_at <= ?3) AS drepStats,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'delegation_digest' AND created_at > ?2 AND created_at <= ?3) AS delegationDigest,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'rationale_ready' AND created_at > ?2 AND created_at <= ?3) AS rationaleReady,
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = ?1 AND type = 'review_published' AND created_at > ?2 AND created_at <= ?3) AS reviews,
         ${govThreadsSinceSql('?2', '?3')} AS governance`
    )
    .bind(row.user_id, row.delivered_until, passEnd)
    .first<{
      replies: number;
      mentions: number;
      governance: number;
      devices: number;
      drepActivity: number;
      drepStatus: number;
      myDelegation: number;
      drepStats: number;
      delegationDigest: number;
      rationaleReady: number;
      reviews: number;
    }>();

  const replies = prefs.reply ? (result?.replies ?? 0) : 0;
  const mentions = prefs.mention ? (result?.mentions ?? 0) : 0;
  const governance = prefs.governance ? (result?.governance ?? 0) : 0;
  const drepActivity = prefs.drep_activity ? (result?.drepActivity ?? 0) : 0;
  const drepStatus = prefs.drep_status ? (result?.drepStatus ?? 0) : 0;
  const myDelegation = prefs.my_delegation ? (result?.myDelegation ?? 0) : 0;
  const drepStats = prefs.drep_stats ? (result?.drepStats ?? 0) : 0;
  const delegationDigest = prefs.delegation_digest ? (result?.delegationDigest ?? 0) : 0;
  const rationaleReady = prefs.rationale_ready ? (result?.rationaleReady ?? 0) : 0;
  const reviews = prefs.governance_review ? (result?.reviews ?? 0) : 0;
  // Security notices are deliberately not gated on prefs: an alert that can be
  // switched off is worthless, so a device pairing always contributes.
  const devices = result?.devices ?? 0;
  const terms = {
    replies,
    mentions,
    governance,
    drepActivity,
    drepStatus,
    myDelegation,
    drepStats,
    delegationDigest,
    rationaleReady,
    reviews,
    devices,
  };
  // Summed from the terms themselves, so a new term can never be left out of the total.
  return { ...terms, total: Object.values(terms).reduce((a, b) => a + b, 0) };
}

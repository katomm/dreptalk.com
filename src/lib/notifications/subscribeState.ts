/// <reference types="@cloudflare/workers-types" />
// Where a visitor stands with one notification event type, for the
// "Subscribe to updates" block: signed out, signed in without any push or
// Telegram channel, subscribed on at least one channel, or muted everywhere.
// Signed-in pages are rendered privately (never edge-cached), so the block can
// branch on this server-side.
import type { NotificationEventType } from '../db/notificationChannels.js';

export type SubscribeState = 'anonymous' | 'no_channel' | 'on' | 'off';

export async function loadSubscribeState(
  db: D1Database | undefined,
  userId: string | null,
  eventType: NotificationEventType,
): Promise<SubscribeState> {
  if (!userId) return 'anonymous';
  if (!db) return 'no_channel';
  // One row per connected channel kind with its pref for this event; prefs
  // are per kind, not per device, and a missing pref row counts as enabled
  // (the same default getPrefs applies).
  const { results } = await db
    .prepare(
      `SELECT COALESCE(p.enabled, 1) AS enabled
         FROM (SELECT DISTINCT channel FROM notification_channels WHERE user_id = ?1) c
         LEFT JOIN notification_prefs p
           ON p.user_id = ?1 AND p.channel = c.channel AND p.event_type = ?2`,
    )
    .bind(userId, eventType)
    .all<{ enabled: number }>();
  if (results.length === 0) return 'no_channel';
  return results.some((r) => r.enabled === 1) ? 'on' : 'off';
}

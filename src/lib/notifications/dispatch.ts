/// <reference types="@cloudflare/workers-types" />
// Cron dispatcher: scans every channel of one kind, bundles each channel's
// pending replies, mentions, governance updates, and delegator events (DRep
// vote activity, DRep status changes, delegation changes) into a single
// message, then advances or prunes the channel's delivery cursor based on the
// send result. Two adapters share the loop: web push (encrypted push payload)
// and telegram (plain bot message). Called from the gov-sync worker's
// 5-minute governance trigger, after the rest of that run's sync work.

import {
  listChannelsByKind,
  getPrefs,
  getPendingCounts,
  claimChannelCursor,
  setChannelCursor,
  deleteChannelById,
  type NotificationChannelKind,
  type NotificationChannelRow,
  type PendingCounts,
} from '../db/notificationChannels.js';
import { formatNotification, DETAIL_MAX, type PendingLead } from './pushMessage.js';
import { resolvePendingLead } from './pendingLead.js';
import { getUnreadCount } from '../db/notifications.js';
import { isSubscriptionDead } from '../push/webPush.js';
import type { sendWebPush, VapidConfig, PushSubscriptionTarget } from '../push/webPush.js';
import { isTelegramChatDead } from '../push/telegram.js';
import type { sendTelegramMessage } from '../push/telegram.js';

export interface DispatchDeps {
  send: typeof sendWebPush; // injected for tests
  now: number;
}

export interface TelegramDispatchConfig {
  botToken: string;
  /** Site origin for the notifications link, e.g. https://dreptalk.com */
  origin: string;
}

export interface TelegramDispatchDeps {
  send: typeof sendTelegramMessage; // injected for tests
  now: number;
}

export interface DispatchResult {
  sent: number;
  pruned: number;
  skipped: number;
}

/** What one adapter did with one channel's bundle. */
type DeliveryOutcome = 'sent' | 'dead' | 'failed';

/**
 * The shared per-kind loop: list channels, cache prefs per user, skip muted
 * and empty channels, claim each pending bundle by advancing the cursor, hand
 * it to the adapter, then keep the claim (sent) or prune the row (dead). A
 * failure on one channel is caught and logged so it never aborts the rest of
 * the scan; other failure outcomes give the cursor back, so the next run
 * retries the same (or larger) bundle.
 */
async function dispatchChannels(
  db: D1Database,
  kind: NotificationChannelKind,
  deliver: (row: NotificationChannelRow, counts: PendingCounts, lead: PendingLead | null) => Promise<DeliveryOutcome>,
  now: number,
): Promise<DispatchResult> {
  const rows = await listChannelsByKind(db, kind);
  let sent = 0;
  let pruned = 0;
  let skipped = 0;
  // Prefs are per (user, channel kind), not per device: cache them for the
  // duration of one pass so a user with several devices costs one query.
  const prefsByUser = new Map<string, Awaited<ReturnType<typeof getPrefs>>>();

  for (const row of rows) {
    // Set once the cursor is claimed, cleared once the outcome is final. Anything
    // still true in the finally hands the claim back, covering both a failed send
    // and a throw, so the bundle is retried instead of silently swallowed.
    let claimed = false;
    try {
      let prefs = prefsByUser.get(row.user_id);
      if (!prefs) {
        prefs = await getPrefs(db, row.user_id, row.channel);
        prefsByUser.set(row.user_id, prefs);
      }
      // Note: a channel with reply/mention/governance all off can still have
      // pending device_paired work, since that term is never prefs-gated, so
      // there is no early-exit here before the counts query.
      const counts = await getPendingCounts(db, row, prefs);
      if (counts.total === 0) {
        skipped++;
        continue;
      }

      // Only resolve the per-item lead for small bundles: those get the detailed
      // single-line message; larger bundles use the count summary and never look
      // at the lead, so the lookup is skipped entirely.
      const lead = counts.total <= DETAIL_MAX ? await resolvePendingLead(db, row, prefs) : null;

      // Claim the bundle before sending, never after: two overlapping runs of
      // this loop otherwise both read the same cursor and deliver the same
      // message. Losing the claim means another run already has this bundle.
      claimed = await claimChannelCursor(db, row.id, row.delivered_until, now);
      if (!claimed) {
        skipped++;
        continue;
      }

      const outcome = await deliver(row, counts, lead);
      if (outcome === 'sent') {
        claimed = false;
        sent++;
      } else if (outcome === 'dead') {
        claimed = false;
        await deleteChannelById(db, row.id);
        pruned++;
      }
    } catch (err) {
      console.error(`[${kind}-dispatch] channel ${row.id} failed`, err);
    } finally {
      if (claimed) await setChannelCursor(db, row.id, row.delivered_until);
    }
  }

  return { sent, pruned, skipped };
}

/**
 * Dispatches bundled web push notifications to every connected webpush
 * channel. Fails soft when the VAPID secret is unset (e.g. mid-rollout):
 * logs once and returns all-zero without touching any channel or sending
 * anything.
 */
export async function dispatchWebPush(
  db: D1Database,
  vapid: VapidConfig | null,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (!vapid) {
    console.warn('[webpush-dispatch] VAPID keys not configured, skipping dispatch');
    return { sent: 0, pruned: 0, skipped: 0 };
  }
  // The app-icon badge shows the same unread count as the header bell, not the
  // per-push bundle size (which resets each send), so it accumulates and clears
  // correctly. Memoized per user so a multi-device account costs one count query
  // per pass, not one per device. Stable within a pass: dispatch only reads.
  const unreadByUser = new Map<string, number>();
  return dispatchChannels(
    db,
    'webpush',
    async (row, counts, lead) => {
      const target = JSON.parse(row.target) as PushSubscriptionTarget;
      const { title, body, path } = formatNotification(counts, lead);
      let badge = unreadByUser.get(row.user_id);
      if (badge === undefined) {
        badge = await getUnreadCount(db, row.user_id);
        unreadByUser.set(row.user_id, badge);
      }
      // The title names the subject, not the app: the OS already shows "DRepTalk"
      // in the notification's own header and (on iOS) a "from DRepTalk" line, so a
      // "DRepTalk" title here would just be a third redundant copy.
      // path is app-relative; the service worker resolves it against its own origin.
      const payload = JSON.stringify({ title, body, url: path, badge });
      const result = await deps.send(target, payload, vapid);
      if (result.ok) return 'sent';
      return isSubscriptionDead(result.status) ? 'dead' : 'failed';
    },
    deps.now,
  );
}

/**
 * Dispatches the same bundles as bot messages to every connected telegram
 * channel. Fails soft when the bot token is unset, mirroring the VAPID path.
 */
export async function dispatchTelegram(
  db: D1Database,
  cfg: TelegramDispatchConfig | null,
  deps: TelegramDispatchDeps,
): Promise<DispatchResult> {
  if (!cfg) {
    console.warn('[telegram-dispatch] bot token not configured, skipping dispatch');
    return { sent: 0, pruned: 0, skipped: 0 };
  }
  return dispatchChannels(
    db,
    'telegram',
    async (row, counts, lead) => {
      const { title, body, path } = formatNotification(counts, lead);
      // Telegram has no separate title field, so fold it into the first line; it
      // also carries no origin context, so the link is absolute.
      const text = `${title}\n${body}\n${cfg.origin}${path}`;
      const result = await deps.send(cfg.botToken, row.target, text);
      if (result.ok) return 'sent';
      return isTelegramChatDead(result) ? 'dead' : 'failed';
    },
    deps.now,
  );
}

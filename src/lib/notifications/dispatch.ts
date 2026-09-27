/// <reference types="@cloudflare/workers-types" />
// Cron dispatcher: scans the channels that may have pending work, least
// recently attempted first, within the run's query allowance. It bundles each
// channel's pending replies, mentions, governance updates, and delegator events
// (DRep vote activity, DRep status changes, delegation changes) into a single
// message, then advances or prunes the channel's delivery cursor based on the
// send result. Two adapters share the loop: web push (encrypted push payload)
// and telegram (plain bot message).

import {
  readPassStart,
  listDispatchCandidates,
  getPrefs,
  getPendingCounts,
  claimChannelCursor,
  handBackChannelCursor,
  markChannelSent,
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
import type { Allowance } from '../sync/queryBudget.js';

/**
 * passEnd and afterPassStart are test seams only. passEnd replaces the
 * database clock bound (dbNow - 1), afterPassStart runs right after the pass
 * start read. Production never sets either.
 */
interface PassSeams {
  passEnd?: number;
  afterPassStart?: () => Promise<void>;
}

export interface DispatchDeps extends PassSeams {
  send: typeof sendWebPush; // injected for tests
  /** This pass's share of the invocation's D1 query budget. */
  allowance: Allowance;
}

export interface TelegramDispatchConfig {
  botToken: string;
  /** Site origin for the notifications link, e.g. https://dreptalk.com */
  origin: string;
}

export interface TelegramDispatchDeps extends PassSeams {
  send: typeof sendTelegramMessage; // injected for tests
  /** This pass's share of the invocation's D1 query budget. */
  allowance: Allowance;
}

export interface DispatchResult {
  sent: number;
  pruned: number;
  skipped: number;
  /** The candidate query hit its limit or the allowance stopped the pass, so channels may be waiting. */
  deferred: boolean;
}

/** What one adapter did with one channel's bundle. */
type DeliveryOutcome = 'sent' | 'dead' | 'failed';

/**
 * Worst case for one channel in queries: prefs, counts, lead (personal and
 * governance reads plus topic, author identity and action lookups), claim,
 * unread badge, and a handback or prune. Measured by the dispatch test
 * "covers the most expensive single-channel path" at 11 (reply lead with a
 * DRep and pool author identity), so 14 leaves headroom. Raise it if that test fails.
 */
export const DISPATCH_QUERIES_PER_CHANNEL_MAX = 14;
/** Pass start read plus candidate query. */
const DISPATCH_FIXED_QUERIES = 2;
/**
 * Upper bound on candidates per pass, so an unlimited allowance (tests,
 * scripts) still binds a finite LIMIT. Far above what the 900-query budget
 * can serve per pass, so it never binds in production.
 */
const DISPATCH_SCAN_CAP = 500;

/**
 * The shared per-kind loop: read the pass start, list candidates within the
 * allowance, cache prefs per user, advance past muted work, claim each pending
 * bundle by advancing the cursor, hand it to the adapter, then keep the claim
 * (sent) or prune the row (dead). A failure on one channel is caught and logged
 * so it never aborts the rest of the pass. Other failure outcomes give the
 * cursor back, so the next run retries the same (or larger) bundle.
 */
async function dispatchChannels(
  db: D1Database,
  kind: NotificationChannelKind,
  deliver: (row: NotificationChannelRow, counts: PendingCounts, lead: PendingLead | null) => Promise<DeliveryOutcome>,
  opts: { allowance: Allowance } & PassSeams,
): Promise<DispatchResult> {
  const { allowance } = opts;
  // Not even the pass start and the candidate query fit: touch nothing.
  if (!allowance.covers(DISPATCH_FIXED_QUERIES)) return { sent: 0, pruned: 0, skipped: 0, deferred: true };
  const start = await readPassStart(db);
  if (opts.afterPassStart) await opts.afterPassStart();
  // The pass interval is delivered_until < ts <= passEnd. A row written after the
  // pass start read has ts >= dbNow and waits for the next pass, so the claim
  // below never moves a cursor past a row this pass did not count.
  const passEnd = opts.passEnd ?? start.dbNow - 1;
  // remaining() already excludes the pass start read, so only the candidate
  // query is left to reserve. Equals floor((allocation - 2) / max) at phase start.
  const limit = Math.min(
    DISPATCH_SCAN_CAP,
    Math.max(0, Math.floor((allowance.remaining() - (DISPATCH_FIXED_QUERIES - 1)) / DISPATCH_QUERIES_PER_CHANNEL_MAX)),
  );
  const rows = await listDispatchCandidates(db, kind, start.latestGovAt, limit);
  let sent = 0;
  let pruned = 0;
  let skipped = 0;
  // With no room for a single channel, the pass read the clock and the
  // candidates for nothing, which is still correct: it reports deferred.
  let deferred = limit === 0 || rows.length === limit;
  // Prefs are per (user, channel kind), not per device: cache them for the
  // duration of one pass so a user with several devices costs one query.
  const prefsByUser = new Map<string, Awaited<ReturnType<typeof getPrefs>>>();

  for (const row of rows) {
    // Every channel reserves its full worst case, failure path included.
    if (!allowance.covers(DISPATCH_QUERIES_PER_CHANNEL_MAX)) {
      deferred = true;
      break;
    }
    // Never move a cursor backwards: a channel connected (or claimed by an
    // overlapping pass) after this pass started already sits past passEnd.
    const nextCursor = Math.max(row.delivered_until, passEnd);
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
      const counts = await getPendingCounts(db, row, prefs, passEnd);
      if (counts.total === 0) {
        // Only muted work, a deleted thread, or rows newer than the pass. Advance
        // over what this pass saw so the channel stops matching the candidate
        // query, and rotate it to the back. Nothing is sent, so nothing to hand back.
        await claimChannelCursor(db, row.id, row.delivered_until, nextCursor, start.dbNow);
        skipped++;
        continue;
      }

      // Only resolve the per-item lead for small bundles: those get the detailed
      // single-line message. Larger bundles use the count summary and never look
      // at the lead, so the lookup is skipped entirely.
      const lead = counts.total <= DETAIL_MAX ? await resolvePendingLead(db, row, prefs, passEnd) : null;

      // Claim the bundle before sending, never after: two overlapping runs of
      // this loop otherwise both read the same cursor and deliver the same
      // message. Losing the claim means another run already has this bundle.
      claimed = await claimChannelCursor(db, row.id, row.delivered_until, nextCursor, start.dbNow);
      if (!claimed) {
        skipped++;
        continue;
      }

      const outcome = await deliver(row, counts, lead);
      if (outcome === 'sent') {
        claimed = false;
        sent++;
        await markChannelSent(db, row.id);
      } else if (outcome === 'dead') {
        claimed = false;
        await deleteChannelById(db, row.id);
        pruned++;
      }
    } catch (err) {
      console.error(`[${kind}-dispatch] channel ${row.id} failed`, err);
    } finally {
      if (claimed) await handBackChannelCursor(db, row.id, nextCursor, row.delivered_until);
    }
  }

  return { sent, pruned, skipped, deferred };
}

/**
 * Dispatches bundled web push notifications to webpush candidates within the
 * allowance. Fails soft when the VAPID secret is unset (e.g. mid-rollout):
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
    return { sent: 0, pruned: 0, skipped: 0, deferred: false };
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
    { allowance: deps.allowance, passEnd: deps.passEnd, afterPassStart: deps.afterPassStart },
  );
}

/**
 * Dispatches the same bundles as bot messages to telegram candidates within
 * the allowance. Fails soft when the bot token is unset, mirroring the VAPID path.
 */
export async function dispatchTelegram(
  db: D1Database,
  cfg: TelegramDispatchConfig | null,
  deps: TelegramDispatchDeps,
): Promise<DispatchResult> {
  if (!cfg) {
    console.warn('[telegram-dispatch] bot token not configured, skipping dispatch');
    return { sent: 0, pruned: 0, skipped: 0, deferred: false };
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
    { allowance: deps.allowance, passEnd: deps.passEnd, afterPassStart: deps.afterPassStart },
  );
}

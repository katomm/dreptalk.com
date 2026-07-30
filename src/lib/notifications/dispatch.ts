/// <reference types="@cloudflare/workers-types" />
// Cron dispatcher: scans every channel of one kind, bundles each channel's
// pending replies, mentions, governance updates, and delegator events (DRep
// vote activity, DRep status changes, delegation changes) into a single
// message, then advances or prunes the channel's delivery cursor based on the
// send result. Two adapters share the loop: web push (encrypted push payload)
// and telegram (plain bot message). Called from the gov-sync worker's
// 15-minute governance trigger, after the rest of that run's sync work.

import {
  listChannelsByKind,
  getPrefs,
  getPendingCounts,
  advanceCursor,
  deleteChannelById,
  type NotificationChannelKind,
  type NotificationChannelRow,
  type PendingCounts,
} from '../db/notificationChannels.js';
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

/** Comma-joined, singular/plural-correct summary of the non-zero pending counts. */
function formatSummary(counts: PendingCounts): string {
  const parts: string[] = [];
  if (counts.replies > 0) {
    parts.push(`${counts.replies} new ${counts.replies === 1 ? 'reply' : 'replies'}`);
  }
  if (counts.mentions > 0) {
    parts.push(`${counts.mentions} ${counts.mentions === 1 ? 'mention' : 'mentions'}`);
  }
  if (counts.governance > 0) {
    parts.push(`${counts.governance} governance ${counts.governance === 1 ? 'update' : 'updates'}`);
  }
  if (counts.drepActivity > 0) {
    parts.push(`${counts.drepActivity} DRep vote ${counts.drepActivity === 1 ? 'update' : 'updates'}`);
  }
  if (counts.drepStatus > 0) {
    parts.push(`${counts.drepStatus} DRep status ${counts.drepStatus === 1 ? 'change' : 'changes'}`);
  }
  if (counts.myDelegation > 0) {
    parts.push(`${counts.myDelegation} delegation ${counts.myDelegation === 1 ? 'change' : 'changes'}`);
  }
  if (counts.devices > 0) {
    parts.push(`${counts.devices} new ${counts.devices === 1 ? 'device' : 'devices'} paired`);
  }
  return parts.join(', ');
}

/** What one adapter did with one channel's bundle. */
type DeliveryOutcome = 'sent' | 'dead' | 'failed';

/**
 * The shared per-kind loop: list channels, cache prefs per user, skip muted
 * and empty channels, hand each pending bundle to the adapter, then advance
 * the cursor (sent) or prune the row (dead). A failure on one channel is
 * caught and logged so it never aborts the rest of the scan; other failure
 * outcomes leave the cursor untouched, so the next run retries the same (or
 * larger) bundle.
 */
async function dispatchChannels(
  db: D1Database,
  kind: NotificationChannelKind,
  deliver: (row: NotificationChannelRow, counts: PendingCounts) => Promise<DeliveryOutcome>,
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

      const outcome = await deliver(row, counts);
      if (outcome === 'sent') {
        await advanceCursor(db, row.id, now);
        sent++;
      } else if (outcome === 'dead') {
        await deleteChannelById(db, row.id);
        pruned++;
      }
    } catch (err) {
      console.error(`[${kind}-dispatch] channel ${row.id} failed`, err);
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
  return dispatchChannels(
    db,
    'webpush',
    async (row, counts) => {
      const target = JSON.parse(row.target) as PushSubscriptionTarget;
      const payload = JSON.stringify({
        title: 'DRepTalk',
        body: formatSummary(counts),
        url: '/notifications/',
      });
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
    async (row, counts) => {
      const text = `${formatSummary(counts)}\n${cfg.origin}/notifications/`;
      const result = await deps.send(cfg.botToken, row.target, text);
      if (result.ok) return 'sent';
      return isTelegramChatDead(result) ? 'dead' : 'failed';
    },
    deps.now,
  );
}

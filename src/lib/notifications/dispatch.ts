/// <reference types="@cloudflare/workers-types" />
// Cron dispatcher for web push: scans every webpush channel, bundles each
// channel's pending replies, mentions, and governance updates into a single
// push notification, then advances or prunes the channel's delivery cursor
// based on the push result. Called from the gov-sync worker's 15-minute
// governance trigger, after the rest of that run's sync work.

import {
  listChannelsByKind,
  getPrefs,
  getPendingCounts,
  advanceCursor,
  deleteChannelById,
  type PendingCounts,
} from '../db/notificationChannels.js';
import type { sendWebPush, VapidConfig, PushSubscriptionTarget } from '../push/webPush.js';

export interface DispatchDeps {
  send: typeof sendWebPush; // injected for tests
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
  return parts.join(', ');
}

/**
 * Dispatches bundled web push notifications to every connected webpush
 * channel. Fails soft when the VAPID secret is unset (e.g. mid-rollout):
 * logs once and returns all-zero without touching any channel or sending
 * anything. Sends run sequentially (a handful of channels per run, no rate
 * concern); a failure on one channel is caught and logged so it never aborts
 * the rest of the scan.
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

  const rows = await listChannelsByKind(db, 'webpush');
  let sent = 0;
  let pruned = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const prefs = await getPrefs(db, row.user_id, row.channel);
      const counts = await getPendingCounts(db, row, prefs);
      if (counts.total === 0) {
        skipped++;
        continue;
      }

      const target = JSON.parse(row.target) as PushSubscriptionTarget;
      const payload = JSON.stringify({
        title: 'DRepTalk',
        body: formatSummary(counts),
        url: '/notifications/',
      });

      const result = await deps.send(target, payload, vapid);
      if (result.ok) {
        await advanceCursor(db, row.id, deps.now);
        sent++;
      } else if (result.status === 404 || result.status === 410) {
        await deleteChannelById(db, row.id);
        pruned++;
      }
      // Any other failure status leaves the cursor untouched: the next run
      // recomputes the same (or larger) pending counts and retries.
    } catch (err) {
      console.error(`[webpush-dispatch] channel ${row.id} failed`, err);
    }
  }

  return { sent, pruned, skipped };
}

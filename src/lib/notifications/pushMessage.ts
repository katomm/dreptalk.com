// Pure formatting for the push/telegram message (title + body): no DB, no I/O,
// so it is unit-testable in node. Given the pending counts (and, for small
// bundles, the single most-recent pending item), it decides between a detailed
// two-line message with a deep link and the count-only summary used for larger
// bundles.
//
// The count summary stays the fallback: a lone "1 governance update" carries no
// signal, so a single pending event is spelled out (title = the subject, body =
// what happened) and links straight to the item; two or three lead with that
// item plus "(+N more)"; four or more collapse back to the comma-joined counts
// under a generic title.

import type { PendingCounts } from '../db/notificationChannels.js';

/**
 * A resolved lead item, split into the two lines a push notification shows: the
 * bold `title` names the subject (thread, proposal, epoch), the `body` says what
 * happened. Kept separate so the title carries real information instead of the
 * app name, which the OS already repeats in the notification's own chrome.
 */
export interface PendingLead {
  /** Bold headline: the subject, e.g. `"Treasury proposal"` or `Epoch 647 · DRep stats`. */
  title: string;
  /** Detail line under it, e.g. `alice replied` or the stat changes. */
  body: string;
  /** App-relative path starting with '/', e.g. `/t/some-slug/`. */
  href: string;
}

/** Up to this many pending events still get the detailed lead treatment. */
export const DETAIL_MAX = 3;

/** The inbox overview, where a message with no single obvious target points. */
const INBOX_PATH = '/notifications/';

/** Title for a mixed bundle with no single subject to name. */
const SUMMARY_TITLE = 'New activity';

/** Comma-joined, singular/plural-correct summary of the non-zero pending counts. */
export function formatSummary(counts: PendingCounts): string {
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
  if (counts.drepStats > 0) {
    parts.push(`${counts.drepStats} DRep stats ${counts.drepStats === 1 ? 'update' : 'updates'}`);
  }
  if (counts.devices > 0) {
    parts.push(`${counts.devices} new ${counts.devices === 1 ? 'device' : 'devices'} paired`);
  }
  return parts.join(', ');
}

/** The final notification title and body plus the path it should open. */
export interface PushMessage {
  title: string;
  body: string;
  path: string;
}

/**
 * Picks the message shape from the pending counts and the resolved lead item:
 *  - exactly one pending event: the lead's title + body, linked to the item;
 *  - two or three: the lead with "(+N more)" on the body, linked to the inbox;
 *  - four or more (or no lead resolved): a generic title + the count-only
 *    summary, to the inbox.
 */
export function formatNotification(counts: PendingCounts, lead: PendingLead | null): PushMessage {
  const total = counts.total;
  if (lead && total === 1) {
    return { title: lead.title, body: lead.body, path: lead.href };
  }
  if (lead && total <= DETAIL_MAX) {
    return { title: lead.title, body: `${lead.body} (+${total - 1} more)`, path: INBOX_PATH };
  }
  return { title: SUMMARY_TITLE, body: formatSummary(counts), path: INBOX_PATH };
}

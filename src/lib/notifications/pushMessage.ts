// Pure formatting for the push/telegram message body: no DB, no I/O, so it is
// unit-testable in node. Given the pending counts (and, for small bundles, the
// single most-recent pending item), it decides between a detailed single-line
// message with a deep link and the count-only summary used for larger bundles.
//
// The count summary stays the fallback: a lone "1 governance update" carries no
// signal, so a single pending event is spelled out ("New governance action:
// <title>") and links straight to the item; two or three lead with that item
// plus "(+N more)"; four or more collapse back to the comma-joined counts.

import type { PendingCounts } from '../db/notificationChannels.js';

/** A resolved lead item: the human sentence and the in-app path to open. */
export interface PendingLead {
  /** One-line description, e.g. `alice replied in "Treasury proposal"`. */
  text: string;
  /** App-relative path starting with '/', e.g. `/t/some-slug/`. */
  href: string;
}

/** Up to this many pending events still get the detailed lead treatment. */
export const DETAIL_MAX = 3;

/** The inbox overview, where a message with no single obvious target points. */
const INBOX_PATH = '/notifications/';

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

/** The final message body plus the path it should open. */
export interface PushMessage {
  body: string;
  path: string;
}

/**
 * Picks the message shape from the pending counts and the resolved lead item:
 *  - exactly one pending event: the lead's own sentence, linked to the item;
 *  - two or three: the lead plus "(+N more)", linked to the inbox;
 *  - four or more (or no lead resolved): the count-only summary, to the inbox.
 */
export function formatNotification(counts: PendingCounts, lead: PendingLead | null): PushMessage {
  const total = counts.total;
  if (lead && total === 1) {
    return { body: lead.text, path: lead.href };
  }
  if (lead && total <= DETAIL_MAX) {
    return { body: `${lead.text} (+${total - 1} more)`, path: INBOX_PATH };
  }
  return { body: formatSummary(counts), path: INBOX_PATH };
}

// Pure logic for the delegator epoch digest: the payload carried on a
// delegation_digest notification row, the rule for when a DRep has anything
// to report, and the copy shared by the inbox row and the push lead. No DB,
// no I/O, unit-testable in node.

import { isNonNegativeInt as isCount } from './drepStats.js';

/** Action titles carried in a payload, newest vote first. */
export const DIGEST_TITLE_MAX = 3;
/** Each title is clipped to this many characters before it is stored. */
export const DIGEST_TITLE_CHARS = 80;

export interface DelegationDigestPayload {
  /** The completed epoch the digest reports on. */
  epoch: number;
  drepId: string;
  /** Actions the DRep voted on in the epoch, counted by vote block time. */
  votes: number;
  /** How many of those votes carry a rationale anchor. */
  withRationale: number;
  /** Up to DIGEST_TITLE_MAX action titles, newest vote first. */
  titles: string[];
  /** Active actions without a vote from the DRep at build time. Null when the DRep is not registered. */
  openUnvoted: number | null;
}

/** A DRep has something to report when it voted or still has open actions to vote on. */
export function isReportable(p: Pick<DelegationDigestPayload, 'votes' | 'openUnvoted'>): boolean {
  return p.votes > 0 || (p.openUnvoted ?? 0) > 0;
}

/**
 * Parses a delegation_digest payload, null for anything malformed. Never
 * throws, so a bad row is dropped rather than crashing the inbox render.
 * Strict on shape, like parseDrepStatsPayload.
 */
export function parseDelegationDigestPayload(payload: string | null): DelegationDigestPayload | null {
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (!isCount(p.epoch) || typeof p.drepId !== 'string' || p.drepId === '') return null;
  if (!isCount(p.votes) || !isCount(p.withRationale) || p.withRationale > p.votes) return null;
  if (!Array.isArray(p.titles) || !p.titles.every((t) => typeof t === 'string')) return null;
  if (p.openUnvoted !== null && !isCount(p.openUnvoted)) return null;
  return {
    epoch: p.epoch,
    drepId: p.drepId,
    votes: p.votes,
    withRationale: p.withRationale,
    titles: p.titles as string[],
    openUnvoted: p.openUnvoted as number | null,
  };
}

const noun = (n: number) => (n === 1 ? 'action' : 'actions');

/** "Voted on 3 actions, 2 with a rationale. 1 open action without a vote" */
export function formatDelegationDigestDetail(p: DelegationDigestPayload): string {
  const voted =
    p.votes === 0
      ? 'No votes'
      : `Voted on ${p.votes} ${noun(p.votes)}, ${p.withRationale === 0 ? 'none' : p.withRationale} with a rationale`;
  const open = p.openUnvoted ? `. ${p.openUnvoted} open ${noun(p.openUnvoted)} without a vote` : '';
  return voted + open;
}

/** Inbox line: "Epoch 612: voted on 3 actions, ..." */
export function formatDelegationDigestSummary(p: DelegationDigestPayload): string {
  const detail = formatDelegationDigestDetail(p);
  return `Epoch ${p.epoch}: ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`;
}

/** "A, B, C and 2 more", null when the payload carries no titles. */
export function formatDelegationDigestTitles(p: DelegationDigestPayload): string | null {
  if (p.titles.length === 0) return null;
  const rest = p.votes - p.titles.length;
  return p.titles.join(', ') + (rest > 0 ? ` and ${rest} more` : '');
}

/** Inbox row: the summary plus "Actions: A, B and 1 more" when titles were stored. */
export function formatDelegationDigestInboxTitle(p: DelegationDigestPayload): string {
  const titles = formatDelegationDigestTitles(p);
  return titles ? `${formatDelegationDigestSummary(p)}. Actions: ${titles}` : formatDelegationDigestSummary(p);
}

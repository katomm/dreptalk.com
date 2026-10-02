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
  /** No longer written (always null). Older rows carry a count of open actions without a vote, which the copy ignores. */
  openUnvoted: number | null;
}

/** A digest is only worth sending when the DRep actually voted in the epoch. */
export function isReportable(p: Pick<DelegationDigestPayload, 'votes'>): boolean {
  return p.votes > 0;
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

/** "Your DRep voted on 2 actions in epoch 658" (older zero-vote rows read "cast no votes"). */
export function formatDelegationDigestHeadline(p: DelegationDigestPayload): string {
  return p.votes === 0
    ? `Your DRep cast no votes in epoch ${p.epoch}`
    : `Your DRep voted on ${p.votes} ${noun(p.votes)} in epoch ${p.epoch}`;
}

/** "A, B, C and 2 more", null when the payload carries no titles. */
export function formatDelegationDigestTitles(p: DelegationDigestPayload): string | null {
  if (p.titles.length === 0) return null;
  const rest = p.votes - p.titles.length;
  return p.titles.join(', ') + (rest > 0 ? ` and ${rest} more` : '');
}

/** "A, B and 1 more. 1 with a rationale", empty for a digest without votes. */
export function formatDelegationDigestDetail(p: DelegationDigestPayload): string {
  if (p.votes === 0) return '';
  const rationale = `${p.withRationale === 0 ? 'None' : p.withRationale} with a rationale`;
  const titles = formatDelegationDigestTitles(p);
  return titles ? `${titles}. ${rationale}` : rationale;
}

/** Inbox row: the headline, then the detail after a colon. */
export function formatDelegationDigestInboxTitle(p: DelegationDigestPayload): string {
  const detail = formatDelegationDigestDetail(p);
  return detail ? `${formatDelegationDigestHeadline(p)}: ${detail}` : formatDelegationDigestHeadline(p);
}

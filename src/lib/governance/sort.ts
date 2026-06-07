// Sorting for the governance-actions list. A DRep usually wants to see where
// engagement is happening or what is closing soon, not the newest submission, so
// the default is "trending". All modes are pure and unit-tested. The action set
// is small (low hundreds), so the page loads it once and sorts in memory.

import type { Topic } from '../db/forum.js';
import type { GovernanceAction } from '../db/governance.js';

export type GovSort = 'trending' | 'new' | 'closing' | 'ratified';

export const GOV_SORTS: readonly { mode: GovSort; label: string }[] = [
  { mode: 'trending', label: 'Trending' },
  { mode: 'new', label: 'New' },
  { mode: 'closing', label: 'Closing Soon' },
  { mode: 'ratified', label: 'Recently Ratified' },
];

const VALID = new Set<string>(GOV_SORTS.map((s) => s.mode));

/** Parses the ?sort= param; defaults to 'trending' for anything unrecognized. */
export function parseGovSort(value: string | null): GovSort {
  return value && VALID.has(value) ? (value as GovSort) : 'trending';
}

export interface GovActionTopic {
  topic: Topic;
  action: GovernanceAction;
}

/** Total on-chain votes cast across all roles (null-safe). */
function totalVotes(a: GovernanceAction): number {
  return [a.drepYes, a.drepNo, a.drepAbstain, a.spoYes, a.spoNo, a.spoAbstain, a.ccYes, a.ccNo, a.ccAbstain]
    .reduce((sum: number, n) => sum + (n ?? 0), 0);
}

/**
 * Trending score for an active action: blends forum engagement (discussion
 * replies + on-chain votes) with the recency of the last reply, so recent and
 * busy actions rank highest. A simple, tunable heuristic.
 */
export function trendingScore(row: GovActionTopic, now: number): number {
  const replies = Math.max(0, row.topic.post_count - 1); // exclude the system first post
  const engagement = replies + totalVotes(row.action);
  const ageDays = Math.max(0, (now - row.topic.last_post_at) / 86_400_000);
  const recency = 1 / (1 + ageDays); // 1.0 just now, decays over days
  return (1 + engagement) * recency;
}

// Epochs are positive; these sentinels push null epochs to the end of either order.
const descKey = (e: number | null) => e ?? -1;
const ascKey = (e: number | null) => e ?? Number.MAX_SAFE_INTEGER;

/**
 * Filters and orders governance-action topics for the given mode (pure):
 *  - trending: active only, by the blended score (default).
 *  - new: all, newest submission first.
 *  - closing: active with an expiry, soonest expiry first.
 *  - ratified: ratified/enacted, most recently decided first.
 */
export function sortGovActionTopics(rows: GovActionTopic[], mode: GovSort, now: number): GovActionTopic[] {
  switch (mode) {
    case 'new':
      return [...rows].sort((a, b) => descKey(b.action.submittedEpoch) - descKey(a.action.submittedEpoch));
    case 'closing':
      return rows
        .filter((r) => r.action.status === 'active' && r.action.expiryEpoch != null)
        .sort((a, b) => ascKey(a.action.expiryEpoch) - ascKey(b.action.expiryEpoch));
    case 'ratified':
      return rows
        .filter((r) => r.action.status === 'ratified' || r.action.status === 'enacted')
        .sort((a, b) => descKey(b.action.decidedEpoch) - descKey(a.action.decidedEpoch));
    case 'trending':
    default:
      return rows
        .filter((r) => r.action.status === 'active')
        .sort((a, b) => trendingScore(b, now) - trendingScore(a, now));
  }
}

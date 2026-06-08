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

export type GovStatusFilter = 'all' | 'active' | 'enacted' | 'expired';

export const GOV_STATUSES: readonly { mode: GovStatusFilter; label: string }[] = [
  { mode: 'all', label: 'All' },
  { mode: 'active', label: 'Active' },
  { mode: 'enacted', label: 'Enacted' },
  { mode: 'expired', label: 'Expired' },
];

const STATUS_VALID = new Set<string>(GOV_STATUSES.map((s) => s.mode));

// Which lifecycle statuses each tab includes. `pending` shows only under All
// (it is "discovered, not yet verified" and is promoted to active by the sync).
const STATUS_GROUPS: Record<Exclude<GovStatusFilter, 'all'>, ReadonlySet<string>> = {
  active: new Set(['active']),
  enacted: new Set(['enacted', 'ratified']),
  expired: new Set(['expired', 'closed', 'dropped']),
};

/** Parses the ?status= param; defaults to 'all'. */
export function parseGovStatus(value: string | null): GovStatusFilter {
  return value && STATUS_VALID.has(value) ? (value as GovStatusFilter) : 'all';
}

/** Filters rows to the tab's status group ('all' passes everything through). */
export function filterByStatus(rows: GovActionTopic[], status: GovStatusFilter): GovActionTopic[] {
  if (status === 'all') return rows;
  const group = STATUS_GROUPS[status];
  return rows.filter((r) => group.has(r.action.status));
}

/**
 * Counts rows per status tab in a single pass, derived from STATUS_GROUPS so the
 * counts cannot drift from filterByStatus when the tab mapping changes.
 */
export function countByStatus(rows: GovActionTopic[]): Record<GovStatusFilter, number> {
  const counts: Record<GovStatusFilter, number> = { all: rows.length, active: 0, enacted: 0, expired: 0 };
  for (const r of rows) {
    const s = r.action.status;
    if (STATUS_GROUPS.active.has(s)) counts.active++;
    else if (STATUS_GROUPS.enacted.has(s)) counts.enacted++;
    else if (STATUS_GROUPS.expired.has(s)) counts.expired++;
  }
  return counts;
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
 * Orders governance-action topics for the given sort mode (pure, no filtering):
 *  - trending: by blended engagement+recency score (default).
 *  - new: newest submission first.
 *  - closing: soonest expiry first, nulls last.
 *  - ratified: most recently decided first, nulls last.
 *
 * Status filtering is handled separately by filterByStatus before calling here.
 */
export function sortGovActionTopics(rows: GovActionTopic[], mode: GovSort, now: number): GovActionTopic[] {
  switch (mode) {
    case 'new':
      return [...rows].sort((a, b) => descKey(b.action.submittedEpoch) - descKey(a.action.submittedEpoch));
    case 'closing':
      return [...rows].sort((a, b) => ascKey(a.action.expiryEpoch) - ascKey(b.action.expiryEpoch));
    case 'ratified':
      return [...rows].sort((a, b) => descKey(b.action.decidedEpoch) - descKey(a.action.decidedEpoch));
    case 'trending':
    default:
      return [...rows].sort((a, b) => trendingScore(b, now) - trendingScore(a, now));
  }
}

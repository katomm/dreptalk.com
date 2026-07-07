// Sorting for the governance-actions list. The default is "new" (newest on-chain
// submission first), the most intuitive entry point; "trending" (engagement +
// recency) sits right next to it for DReps who want to see where discussion is
// happening. All modes are pure and unit-tested.

import type { Topic } from '../db/forum.js';
import type { GovernanceAction } from '../db/governance.js';
import { isTerminalStatus } from './view.js';

export type GovSort = 'trending' | 'new' | 'closing' | 'ratified';

export const GOV_SORTS: readonly { mode: GovSort; label: string }[] = [
  { mode: 'new', label: 'Newest' },
  { mode: 'trending', label: 'Trending' },
  { mode: 'closing', label: 'Closing soonest' },
  { mode: 'ratified', label: 'Recently decided' },
];

const VALID = new Set<string>(GOV_SORTS.map((s) => s.mode));

/** Parses the ?sort= param; defaults to 'new' for anything unrecognized. */
export function parseGovSort(value: string | null): GovSort {
  return value && VALID.has(value) ? (value as GovSort) : 'new';
}

// Lifecycle status filter for the governance list. Independent of sort: status narrows
// the set (open vs. decided), sort only orders it. 'all' is the default (no filter).
export type GovStatus = 'all' | 'open' | 'decided';

export const GOV_STATUSES: readonly { mode: GovStatus; label: string }[] = [
  { mode: 'all', label: 'All' },
  { mode: 'open', label: 'Open' },
  { mode: 'decided', label: 'Decided' },
];

const VALID_STATUS = new Set<string>(GOV_STATUSES.map((s) => s.mode));

/** Parses the ?status= param; defaults to 'all' for anything unrecognized. */
export function parseGovStatus(value: string | null): GovStatus {
  return value && VALID_STATUS.has(value) ? (value as GovStatus) : 'all';
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

// Trending weighting. Tunable; chosen so recent discussion and ongoing voting beat
// old, vote-heavy actions:
//  - REPLY_WEIGHT: a human reply is the scarce, meaningful signal, so it counts for
//    more than a single vote. With the log damping below, roughly 3 replies are worth
//    about a thousand votes.
//  - HALF_LIFE_DAYS: the recency multiplier halves for every week without activity, a
//    far stronger decay than the old 1/(1+age) so vote magnitude cannot swamp it.
//  - TERMINAL_PENALTY: decided actions still appear but sink far down, so a quiet list
//    is never empty yet "trending" reads as what is live.
const REPLY_WEIGHT = 3;
const HALF_LIFE_DAYS = 7;
const TERMINAL_PENALTY = 0.15;
const HALF_LIFE_MS = HALF_LIFE_DAYS * 86_400_000;

/**
 * Engagement term: weighted forum replies plus log-damped on-chain votes. The tunable
 * part of the heuristic, isolated so the trending order has a single definition.
 */
function engagementOf(row: GovActionTopic): number {
  const replies = Math.max(0, row.topic.post_count - 1); // exclude the system first post
  return replies * REPLY_WEIGHT + Math.log2(1 + totalVotes(row.action));
}

/**
 * Canonical, time-invariant trending key. Stored on the row by the gov-sync cron so the
 * list can be ordered and paged in the database instead of after loading every action.
 * This is the single source of truth for trending order; trendingScore below is derived
 * from it, so the in-memory sort and the materialized DB order cannot disagree.
 *
 * Blends engagement with recency and penalises terminal (decided) actions so they sink.
 * With no replies and no votes the key is just the recency term, so a brand-new action
 * still surfaces and orders by its post date (which the sync sets to the on-chain
 * submission time). Ordering rows by this DESC is identical to ordering them by the live
 * recency-decayed score for ANY now:
 *
 *   recency = 0.5^((now - lpa)/HALF_LIFE) = 2^(-now/HALF_LIFE) * 2^(lpa/HALF_LIFE)
 *
 * The 2^(-now/HALF_LIFE) factor is the same for every row at a given render, so it
 * cancels in any comparison. Taking log2 of the surviving (1+engagement) * 2^(lpa/H)
 * (and the *TERMINAL_PENALTY) gives the additive, clock-free form below; storing the log
 * keeps 2^(lpa/H) (astronomically large) from overflowing float64.
 */
export function trendingOrderKey(row: GovActionTopic): number {
  const key = Math.log2(1 + engagementOf(row)) + row.topic.last_post_at / HALF_LIFE_MS;
  return isTerminalStatus(row.action.status) ? key + Math.log2(TERMINAL_PENALTY) : key;
}

/**
 * Live trending score at a given clock, the inverse of trendingOrderKey's log transform:
 * the stored key is log2(score) + now/HALF_LIFE_MS, so the score is 2^(key - now/H).
 * Derived from the one ordering definition (used by the in-memory sort and its tests).
 * Exact while last_post_at <= now (the contract: submission epochs are past, replies use
 * the wall clock), so the old max(0, ageDays) recency clamp is neither possible nor needed.
 */
export function trendingScore(row: GovActionTopic, now: number): number {
  return 2 ** (trendingOrderKey(row) - now / HALF_LIFE_MS);
}

// Epochs are positive; these sentinels push null epochs to the end of either order.
const descKey = (e: number | null) => e ?? -1;
const ascKey = (e: number | null) => e ?? Number.MAX_SAFE_INTEGER;

/**
 * Orders governance-action topics for the given sort mode:
 *  - trending: blended engagement + recency score, terminal actions penalised (default).
 *  - new: newest submission first.
 *  - closing: open actions only (terminal ones have no time left), soonest expiry first, nulls last.
 *  - ratified: most recently decided first, nulls last.
 *
 * All modes order the full set except 'closing', which also drops terminal actions
 * (a "Closing Soon" list with already-closed actions in it is just wrong).
 */
export function sortGovActionTopics(rows: GovActionTopic[], mode: GovSort, now: number): GovActionTopic[] {
  switch (mode) {
    case 'new':
      // Exact on-chain submission time first (newest); submission epoch then topic
      // id are fallbacks while submitted_at is still null. Mirrors govPageOrderBy('new').
      return [...rows].sort((a, b) => {
        const byAt = descKey(b.action.submittedAt) - descKey(a.action.submittedAt);
        if (byAt !== 0) return byAt;
        const byEpoch = descKey(b.action.submittedEpoch) - descKey(a.action.submittedEpoch);
        if (byEpoch !== 0) return byEpoch;
        return a.topic.id.localeCompare(b.topic.id);
      });
    case 'closing':
      return rows
        .filter((r) => !isTerminalStatus(r.action.status))
        .sort((a, b) => ascKey(a.action.expiryEpoch) - ascKey(b.action.expiryEpoch));
    case 'ratified':
      return [...rows].sort((a, b) => descKey(b.action.decidedEpoch) - descKey(a.action.decidedEpoch));
    default: {
      // Score each row once (a comparator would recompute it O(n log n) times), then
      // order: score descending; ties (submissions cluster at 5-day epoch starts) break
      // by newest submission, then topic id, so the order is fully deterministic.
      const scored = rows.map((row) => ({ row, score: trendingScore(row, now) }));
      scored.sort((a, b) => {
        const byScore = b.score - a.score;
        if (byScore !== 0) return byScore;
        const byEpoch = descKey(b.row.action.submittedEpoch) - descKey(a.row.action.submittedEpoch);
        if (byEpoch !== 0) return byEpoch;
        return a.row.topic.id.localeCompare(b.row.topic.id);
      });
      return scored.map((s) => s.row);
    }
  }
}

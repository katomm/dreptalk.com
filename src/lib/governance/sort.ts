// Sorting for the governance-actions list. A DRep usually wants to see where
// engagement is happening or what is closing soon, not the newest submission, so
// the default is "trending". All modes are pure and unit-tested. The action set
// is small (low hundreds), so the page loads it once and sorts in memory.

import type { Topic } from '../db/forum.js';
import type { GovernanceAction } from '../db/governance.js';
import { isTerminalStatus } from './view.js';

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

/**
 * Trending score for a governance action. Blends engagement (forum replies,
 * weighted, plus log-damped on-chain votes) with an exponential recency decay on the
 * last activity, then penalises terminal (decided) actions so they sink. With no
 * replies and no votes the score is just the recency term, so a brand-new action
 * still surfaces and orders by its post date (which the sync sets to the on-chain
 * submission time). A simple, tunable heuristic.
 */
export function trendingScore(row: GovActionTopic, now: number): number {
  const replies = Math.max(0, row.topic.post_count - 1); // exclude the system first post
  const engagement = replies * REPLY_WEIGHT + Math.log2(1 + totalVotes(row.action));
  const ageDays = Math.max(0, (now - row.topic.last_post_at) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS); // halves every HALF_LIFE_DAYS
  const base = (1 + engagement) * recency;
  return isTerminalStatus(row.action.status) ? base * TERMINAL_PENALTY : base;
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
      return [...rows].sort((a, b) => descKey(b.action.submittedEpoch) - descKey(a.action.submittedEpoch));
    case 'closing':
      return rows
        .filter((r) => !isTerminalStatus(r.action.status))
        .sort((a, b) => ascKey(a.action.expiryEpoch) - ascKey(b.action.expiryEpoch));
    case 'ratified':
      return [...rows].sort((a, b) => descKey(b.action.decidedEpoch) - descKey(a.action.decidedEpoch));
    case 'trending':
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

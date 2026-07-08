// Pure decision logic for the personalized homepage hero (logged-in DReps).
// No I/O: the page performs the DB reads and feeds these functions, which stay
// unit-testable. See docs/planning for the design.

import type { DrepVoteHistoryRow } from '../db/drepVotes.js';

const ACTIVE_STATUS = 'active';

/**
 * Orders a DRep's vote history into featured-action candidates for the hero:
 * actions still open for voting first, then concluded ones, each group most
 * recent vote first (null block_time last). Rows lacking a title or a topic
 * slug are dropped, since the hero card needs both to render and link. Pure,
 * does not mutate the input.
 */
export function orderVoteCandidates(history: DrepVoteHistoryRow[]): DrepVoteHistoryRow[] {
  const renderable = history.filter((r) => r.title != null && r.topic_slug != null);
  const byRecency = (a: DrepVoteHistoryRow, b: DrepVoteHistoryRow) => (b.block_time ?? -1) - (a.block_time ?? -1);
  const active = renderable.filter((r) => r.status === ACTIVE_STATUS).sort(byRecency);
  const rest = renderable.filter((r) => r.status !== ACTIVE_STATUS).sort(byRecency);
  return [...active, ...rest];
}

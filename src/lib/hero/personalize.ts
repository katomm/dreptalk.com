// Pure decision logic for the personalized homepage hero (logged-in DReps).
// No I/O: the page performs the DB reads and feeds these functions, which stay
// unit-testable. See docs/planning for the design.

import type { ActionVoterRow, DrepVoteHistoryRow } from '../db/drepVotes.js';

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

export interface PersonalizedRing {
  /** Inner-ring voters, the viewer pinned at index 0. */
  active: ActionVoterRow[];
  /** Outer-ring (dimmed) voters; never contains the viewer. */
  ghosts: ActionVoterRow[];
  /** Index of the viewer's pill within `active` (always 0). */
  selfIndex: number;
}

/**
 * Splits the fetched voters (power-sorted, as getActionVoters returns them) into
 * the inner active ring and the outer ghost ring, with the viewer's own pill
 * pinned to the first active slot. When the viewer is among the voters their row
 * is moved up; otherwise a minimal self row is synthesized from viewerDrepId and
 * their vote (the caller resolves the avatar and name from the dreps map). Pure.
 */
export function buildPersonalizedRing(params: {
  voters: ActionVoterRow[];
  viewerDrepId: string;
  viewerVote: string;
  maxActive: number;
  maxGhosts: number;
}): PersonalizedRing {
  const { voters, viewerDrepId, viewerVote, maxActive, maxGhosts } = params;
  const existing = voters.find((v) => v.voter_id === viewerDrepId);
  const selfRow: ActionVoterRow = existing ?? {
    voter_id: viewerDrepId,
    vote: viewerVote,
    voting_power: null,
    hex: null,
    voter_hex: null,
    image_url: null,
    block_time: null,
  };
  const others = voters.filter((v) => v.voter_id !== viewerDrepId);
  const otherActive = Math.max(maxActive - 1, 0);
  const active = [selfRow, ...others.slice(0, otherActive)];
  const ghosts = others.slice(otherActive, otherActive + maxGhosts);
  return { active, ghosts, selfIndex: 0 };
}

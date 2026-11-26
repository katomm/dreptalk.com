// The per-action reading shared by the hub's Constitutional Committee panel and
// the member profile pages: which decided actions count, which committee judges
// each, and each member's final vote. Both surfaces call this so their numbers
// cannot drift apart. Votes are deduplicated without a cutoff, a vote cast in
// the boundary epoch still counts.
import { activeCommitteeMembersAtBoundary, committeeBoundaryForAction, type CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import { finalCcVoteByMember } from '../koios/corrections.js';
import type { CcVoteRow, DecidedCcAction } from '../db/committee.js';
import { isCcEligible } from '../governance/view.js';

export interface ConsideredCcAction {
  action: DecidedCcAction;
  boundary: number;
  active: Set<string>;
  votes: CcVoteRow[];
  finalByCold: Map<string, CcVoteRow>;
}

/**
 * CC-eligible decided actions that can be placed in time and had an active
 * committee, ascending by decided epoch then gaId. Eligible actions that
 * cannot be resolved are counted in `skipped`.
 */
export function consideredCcActions(input: {
  actions: DecidedCcAction[];
  votesByAction: Map<string, CcVoteRow[]>;
  members: CommitteeMemberTerm[];
  hotToCold: Map<string, string>;
  currentEpoch: number | null;
}): { considered: ConsideredCcAction[]; skipped: number } {
  const { actions, votesByAction, members, hotToCold, currentEpoch } = input;
  const considered: ConsideredCcAction[] = [];
  let skipped = 0;
  const eligible = actions
    .filter((a) => isCcEligible(a.type))
    .sort((x, y) => x.decidedEpoch - y.decidedEpoch || x.gaId.localeCompare(y.gaId));
  for (const action of eligible) {
    const boundary = committeeBoundaryForAction(action, currentEpoch);
    if (boundary == null) {
      skipped += 1;
      continue;
    }
    const active = activeCommitteeMembersAtBoundary(members, boundary);
    if (active.size === 0) {
      skipped += 1;
      continue;
    }
    const votes = votesByAction.get(action.gaId) ?? [];
    considered.push({ action, boundary, active, votes, finalByCold: finalCcVoteByMember(votes, members, hotToCold, boundary) });
  }
  return { considered, skipped };
}

/// <reference types="@cloudflare/workers-types" />
// One entry point that turns a delegator user id into everything the delegation
// dashboard renders: the resolved view state plus (for a drep-follow) the
// followed DRep's steckbrief, recent confirmed history, superseded-vote map,
// and open (unvoted) actions.
import { getFollow } from './delegatorFollows.js';
import { resolveDelegationView, type DelegationView } from '../delegation/delegationView.js';
import { getDrepById, type Drep } from './dreps.js';
import { getDrepVotingHistory, type DrepVoteHistoryRow } from './drepVotes.js';
import { getVoterVoteHistory, type SupersededVote } from './voteHistory.js';
import { getVotableActionsForViewer, type VotableActionRow } from './votableActions.js';

// Dashboard teaser depth: only the most recent confirmed votes render, not the
// DRep's whole history (that lives on the DRep's own profile page).
const HISTORY_LIMIT = 5;

export interface DelegationData {
  view: DelegationView;
  /** Only for view.kind === 'drep'; null if the drep id has no synced dreps row. */
  drep: Drep | null;
  history: DrepVoteHistoryRow[];
  earlier: Map<string, SupersededVote[]>;
  /** Active actions the followed DRep has not voted on (no vote, or only a
   *  local/unconfirmed self-cast). Ordered soonest-expiry first. */
  openActions: VotableActionRow[];
}

const EMPTY: Pick<DelegationData, 'drep' | 'history' | 'earlier' | 'openActions'> = {
  drep: null,
  history: [],
  earlier: new Map(),
  openActions: [],
};

/** Default view when there is no DB handle (defensive fallback for callers like home.astro). */
export const NO_FOLLOW_DELEGATION: DelegationData = { view: { kind: 'no-follow' }, ...EMPTY };

/**
 * Resolves the follow, and for a drep-follow loads the steckbrief + history +
 * superseded map + open actions in parallel. Non-drep states (abstain,
 * no_confidence, none, pending, no-follow) skip the drep queries entirely and
 * return empties.
 */
export async function loadDelegation(db: D1Database, userId: string): Promise<DelegationData> {
  const follow = await getFollow(db, userId);
  const view = resolveDelegationView(follow);

  if (view.kind !== 'drep') {
    return { view, ...EMPTY };
  }

  const [drep, history, earlier, votableRows] = await Promise.all([
    getDrepById(db, view.drepId),
    getDrepVotingHistory(db, view.drepId, { limit: HISTORY_LIMIT, confirmedOnly: true }),
    getVoterVoteHistory(db, view.drepId),
    getVotableActionsForViewer(db, view.drepId),
  ]);

  // Open = the DRep has not cast a vote, or only a still-unconfirmed local one
  // (a pending/failed self-cast is not an on-chain vote).
  const openActions = votableRows.filter((row) => row.viewerVote == null || row.viewerStatus != null);

  return { view, drep, history, earlier, openActions };
}

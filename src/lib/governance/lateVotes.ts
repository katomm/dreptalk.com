// Identifies votes that were cast too late to count in an action's frozen tally.
//
// A governance action's tally is decided from the vote snapshot at an epoch
// boundary. A vote recorded on or after the epoch in which the action was
// ratified therefore never entered the tally, even though it is a valid on-chain
// vote (and may carry a rationale). We surface those distinctly on the Positions
// tab rather than let them read as if they counted.
import { epochFromUnix, resolveNetwork } from '../config/network.js';

interface VoterLike {
  voter_id: string;
  block_time: number | null;
}

interface ActionLike {
  status: string;
  decidedEpoch: number | null;
}

/**
 * Voter ids whose vote was cast on or after the ratification epoch, so it did not
 * count in the tally. Only computed for 'ratified' actions: there decided_epoch is
 * exactly the ratification epoch. For 'enacted' actions decided_epoch may hold the
 * later enacted epoch, which would misclassify votes in the ratification epoch, so
 * we return an empty set rather than guess.
 */
export function lateVoterIds(voters: VoterLike[], action: ActionLike, network: string): Set<string> {
  const out = new Set<string>();
  if (action.status !== 'ratified' || action.decidedEpoch == null) return out;
  const cfg = resolveNetwork(network);
  for (const v of voters) {
    if (v.block_time == null) continue;
    if (epochFromUnix(v.block_time, cfg) >= action.decidedEpoch) out.add(v.voter_id);
  }
  return out;
}

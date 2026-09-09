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
  /** Epoch the action was ratified in, independent of any later enactment. */
  ratifiedEpoch: number | null;
}

/**
 * Voter ids whose vote was cast on or after the ratification epoch, so it did not
 * count in the tally.
 *
 * ratified_epoch is the authoritative input and holds across the whole lifecycle,
 * so a vote keeps its verdict when the action moves from 'ratified' to 'enacted'.
 * Rows synced before migration 0093 have no ratified_epoch: there we still accept
 * decided_epoch, but only while the status is 'ratified', because for an enacted
 * action decided_epoch may already hold the later enacted epoch and would
 * misclassify votes cast in the ratification epoch. An action that never reached
 * ratification (expired, dropped) has no such boundary at all.
 */
export function lateVoterIds(voters: VoterLike[], action: ActionLike, network: string): Set<string> {
  const out = new Set<string>();
  const ratifiedEpoch =
    action.ratifiedEpoch ?? (action.status === 'ratified' ? action.decidedEpoch : null);
  if (ratifiedEpoch == null) return out;
  const cfg = resolveNetwork(network);
  for (const v of voters) {
    if (v.block_time == null) continue;
    if (epochFromUnix(v.block_time, cfg) >= ratifiedEpoch) out.add(v.voter_id);
  }
  return out;
}

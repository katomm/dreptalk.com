// The read seam for the voting-timing snapshot. Both pages call one of these
// instead of the aggregate functions, so the snapshot-or-fallback branch lives
// in one testable place rather than inside an .astro frontmatter block.
//
// On a snapshot hit no live aggregate runs at all. The live calls must not be
// started speculatively next to the snapshot read and then discarded, which
// would keep the whole cost and add a read on top.
//
// Age is deliberately not part of the decision. A staleness triggered recompute
// would bring the full request-time load back exactly when the cron is broken,
// which is the worst possible moment. An old snapshot keeps being served, and
// debug/sync reports it as overdue.

import type { NetworkConfig } from '../config/network.js';
import type { NetworkTypeTiming } from '../db/recordDiagnostics.js';
import { getNetworkTimingByType } from '../db/recordDiagnostics.js';
import { readVotingTimingSnapshot } from '../db/votingTimingSnapshot.js';
import { loadVotingTimingSnapshot } from './votingTimingSnapshot.js';
import { buildVotingTiming, type VotingTimingView } from './votingTimingView.js';

/** Analytics hub: the full timing view. Falls back to all six aggregate reads. */
export async function resolveVotingTimingView(db: D1Database, cfg: NetworkConfig): Promise<VotingTimingView> {
  const snap = await readVotingTimingSnapshot(db);
  if (snap?.payload) return buildVotingTiming(snap.payload);
  return buildVotingTiming(await loadVotingTimingSnapshot(db, cfg));
}

/**
 * Governance record page: only the DRep per-type list. Its fallback stays the
 * single aggregate call the page makes today, so a missing snapshot never makes
 * this page more expensive than it was before the snapshot existed.
 */
export async function resolveNetworkTypeTiming(db: D1Database): Promise<NetworkTypeTiming[]> {
  const snap = await readVotingTimingSnapshot(db);
  if (snap?.payload) return snap.payload.drepByType;
  return getNetworkTimingByType(db, 'DRep');
}

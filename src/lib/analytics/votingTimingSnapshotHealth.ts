// Turns one stored voting-timing snapshot row into a state for the diagnostics
// page. Named for its table rather than generically: it is hardcoded to this
// one snapshot and imports that table's overdue constant, so a generic name
// would advertise reuse it does not offer.
//
// 'invalid' outranks 'overdue': a fresh but unusable row means every render is
// silently taking the expensive fallback, which is worse than stale numbers.
import { SNAPSHOT_OVERDUE_MS, type StoredVotingTimingSnapshot } from '../db/votingTimingSnapshot.js';

export type VotingTimingSnapshotState = 'absent' | 'invalid' | 'overdue' | 'fresh';

export interface VotingTimingSnapshotHealth {
  state: VotingTimingSnapshotState;
  ageMs: number | null;
  epoch: number | null;
}

export function classifySnapshot(
  snapshot: StoredVotingTimingSnapshot | null,
  now: number,
): VotingTimingSnapshotHealth {
  if (!snapshot) return { state: 'absent', ageMs: null, epoch: null };
  const ageMs = now - snapshot.computedAt;
  const epoch = snapshot.epoch;
  if (!snapshot.payload) return { state: 'invalid', ageMs, epoch };
  return { state: ageMs > SNAPSHOT_OVERDUE_MS ? 'overdue' : 'fresh', ageMs, epoch };
}

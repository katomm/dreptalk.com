// Pure committee-membership math on top of the Koios /committee_info shape.
import type { CommitteeMember } from './client.js';

/**
 * Number of committee members the ledger counts for the CIP-1694 min-size rule:
 * authorized (hot credential registered, not resigned) and term not expired. A
 * member is still active during its expiration epoch itself; without a current
 * epoch the expiry check is skipped rather than guessed.
 */
export function activeCommitteeSize(
  members: CommitteeMember[],
  currentEpoch: number | null,
): number {
  return members.filter(
    (m) =>
      m.status === 'authorized' &&
      (m.expiration_epoch == null || currentEpoch == null || m.expiration_epoch >= currentEpoch),
  ).length;
}

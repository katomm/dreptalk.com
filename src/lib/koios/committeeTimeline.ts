// Pure committee-membership timeline math. No I/O. Given the committee's members
// with their version window, term expiration, hot-key authorization start, and
// optional resignation epoch, it computes the committee the ledger counts at an
// epoch boundary: the denominator for the constitutional committee's
// yes-percentage and the roster a review reports. The constitutional committee
// is not static (its size and membership have changed several times), so the
// set must be resolved per action at the boundary that decided it.
import { isTerminalStatus } from '../governance/view.js';

export interface CommitteeMemberTerm {
  /** Cold-key credential hash (hex), the stable member identity across hot-key rotations. */
  coldKeyHex: string;
  /** First epoch this committee version is active. */
  versionFrom: number;
  /** Last active epoch of this version, or null when it is the current version. */
  versionTo: number | null;
  /** Epoch the member's term expires. The member is still active during this epoch itself. */
  termExpiration: number;
  /** First epoch the member had a registered hot key and could cast a vote. */
  authorizedFrom: number;
  /** Epoch the member de-registered its hot key (resigned), or null when still active. */
  resignedAt: number | null;
}

/** Why a seated member does not count at a boundary. */
export type CommitteeExclusion = 'expired' | 'not-authorized' | 'resigned';

/** Whether the member's committee version is the one in force during `epoch`. */
export function versionCovers(m: CommitteeMemberTerm, epoch: number): boolean {
  return m.versionFrom <= epoch && (m.versionTo == null || m.versionTo >= epoch);
}

/**
 * The standing of a seated member at the boundary that opens `epoch`, or null
 * when the ledger counts the member there. Conway ratifies at the epoch
 * transition, with the committee enactments of that boundary already applied,
 * comparing terms with `epoch` itself, and seeing the certificate state from
 * before any transaction of `epoch`. So a term that ended with the previous
 * epoch is out, a hot key authorized inside `epoch` does not count yet, and a
 * resignation inside `epoch` has not happened yet: a member who resigned in the
 * epoch a ratification opened still voted at that boundary.
 */
export function committeeStanding(m: CommitteeMemberTerm, epoch: number): CommitteeExclusion | null {
  if (m.termExpiration < epoch) return 'expired';
  if (m.authorizedFrom > epoch - 1) return 'not-authorized';
  if (m.resignedAt != null && m.resignedAt < epoch) return 'resigned';
  return null;
}

/**
 * The cold-key members the ledger counts at the boundary that opens `epoch`:
 * the seats of the version in force from `epoch` whose standing is clear. The
 * single source for both the denominator (its size) and which cast votes
 * count, so the two can never drift.
 */
export function activeCommitteeMembersAtBoundary(members: CommitteeMemberTerm[], epoch: number): Set<string> {
  const active = new Set<string>();
  for (const m of members) {
    if (versionCovers(m, epoch) && committeeStanding(m, epoch) == null) active.add(m.coldKeyHex);
  }
  return active;
}

/** The active committee size at the boundary: the yes-percentage denominator (before abstains leave it). */
export function activeCommitteeSizeAtBoundary(members: CommitteeMemberTerm[], epoch: number): number {
  return activeCommitteeMembersAtBoundary(members, epoch).size;
}

/** The lifecycle fields the decision boundary of an action is derived from. */
export interface DecisionBoundaryInput {
  status: string;
  decidedEpoch: number | null;
  ratifiedEpoch?: number | null;
  expiryEpoch?: number | null;
}

/**
 * The epoch whose opening boundary decided an action, or null while it is
 * still open or nothing places it in time. The single rule the CC tally, the
 * threshold snapshot, the CC breakdown and the review pack all use, so they
 * never resolve different committees. Ratified and enacted actions were
 * decided at the start of the ratified epoch. A row from before the
 * ratified_epoch column carries only the enactment epoch, one past the
 * ratification, so the boundary is derived from it. An expired action was
 * decided at the start of its expiry epoch, a dropped or closed one at the
 * start of the epoch the record dates that to.
 */
export function decisionBoundaryEpoch(a: DecisionBoundaryInput): number | null {
  if (!isTerminalStatus(a.status)) return null;
  if (a.ratifiedEpoch != null) return a.ratifiedEpoch;
  if (a.status === 'enacted') return a.decidedEpoch != null ? a.decidedEpoch - 1 : null;
  if (a.status === 'expired') return a.expiryEpoch ?? a.decidedEpoch;
  return a.decidedEpoch;
}

/**
 * The boundary whose committee judges an action: its decision boundary once
 * decided, otherwise the next transition (`currentEpoch + 1`), the earliest
 * point the ledger can decide it. Null when neither is known.
 */
export function committeeBoundaryForAction(a: DecisionBoundaryInput, currentEpoch: number | null): number | null {
  return decisionBoundaryEpoch(a) ?? (currentEpoch != null ? currentEpoch + 1 : null);
}

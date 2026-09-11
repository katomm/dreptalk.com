// Pure committee-membership timeline math. No I/O. Given the committee's members
// with their version window, term expiration, hot-key authorization start, and
// optional resignation epoch, it computes the ledger-active committee size at any
// epoch: the denominator for the constitutional committee's yes-percentage. The
// constitutional committee is not static (its size and membership have changed
// several times), so the size must be resolved per action at its decided epoch.

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

/**
 * The cold-key members the ledger counts as active at `epoch`: members of the
 * version covering `epoch` whose term has not expired and who are authorized (a
 * registered hot key, not yet resigned). A member is active during its expiration
 * epoch itself; resignation takes effect from its own epoch (a member who resigns
 * at E is out at E). This is the single source for both the denominator (its size)
 * and which cast votes count, so the two can never drift.
 */
export function activeCommitteeMembersAt(members: CommitteeMemberTerm[], epoch: number): Set<string> {
  const active = new Set<string>();
  for (const m of members) {
    if (
      m.versionFrom <= epoch &&
      (m.versionTo == null || m.versionTo >= epoch) &&
      m.termExpiration >= epoch &&
      m.authorizedFrom <= epoch &&
      (m.resignedAt == null || m.resignedAt > epoch)
    ) {
      active.add(m.coldKeyHex);
    }
  }
  return active;
}

/** The active committee size at `epoch`: the yes-percentage denominator (before abstains leave it). */
export function activeCommitteeSizeAt(members: CommitteeMemberTerm[], epoch: number): number {
  return activeCommitteeMembersAt(members, epoch).size;
}

/**
 * When a committee is resolved. The ledger decides a governance action at an
 * epoch boundary, so a decided action is judged by the committee that stood at
 * that boundary ('boundary', epoch R = the epoch the boundary opens). An action
 * still open has no such point yet and is described as observed at the end of
 * an epoch ('observed'), the epoch-end reading activeCommitteeMembersAt gives.
 * A bare number is read as an observed epoch, which keeps older callers valid.
 */
export type CommitteeReference = { kind: 'boundary'; epoch: number } | { kind: 'observed'; epoch: number };

export function observedAt(epoch: number): CommitteeReference {
  return { kind: 'observed', epoch };
}

export function boundaryOf(epoch: number): CommitteeReference {
  return { kind: 'boundary', epoch };
}

/**
 * The cold-key members the ledger counts at the boundary that opens epoch R.
 * Conway ratifies at the epoch transition into R: the committee enactments of
 * that same boundary are applied first, the ratification check then compares
 * with R itself (Ratify.hs, committeeAcceptedRatio), and the certificate state
 * it sees is the one before any transaction of epoch R. Hence:
 *  - the version in force from R counts (a committee change enacted at this
 *    boundary is already the committee),
 *  - a term that expires before R is out, one expiring in R-1 included,
 *  - a hot key authorized inside R does not count yet (authorizedFrom <= R-1),
 *  - a resignation inside R has not happened yet (resignedAt >= R stays active).
 * The last rule is what separates this from the epoch-end reading: a member who
 * resigned in the epoch a ratification opened still voted at that boundary.
 */
export function activeCommitteeMembersAtBoundary(members: CommitteeMemberTerm[], epoch: number): Set<string> {
  const active = new Set<string>();
  for (const m of members) {
    if (
      m.versionFrom <= epoch &&
      (m.versionTo == null || m.versionTo >= epoch) &&
      m.termExpiration >= epoch &&
      m.authorizedFrom <= epoch - 1 &&
      (m.resignedAt == null || m.resignedAt >= epoch)
    ) {
      active.add(m.coldKeyHex);
    }
  }
  return active;
}

/** The active members for a reference, boundary or observed. */
export function activeCommitteeMembersFor(members: CommitteeMemberTerm[], ref: CommitteeReference | number): Set<string> {
  if (typeof ref === 'number') return activeCommitteeMembersAt(members, ref);
  return ref.kind === 'boundary' ? activeCommitteeMembersAtBoundary(members, ref.epoch) : activeCommitteeMembersAt(members, ref.epoch);
}

/** The active committee size for a reference: the denominator before abstains leave it. */
export function activeCommitteeSizeFor(members: CommitteeMemberTerm[], ref: CommitteeReference | number): number {
  return activeCommitteeMembersFor(members, ref).size;
}

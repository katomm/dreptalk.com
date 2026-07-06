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

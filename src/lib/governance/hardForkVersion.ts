// Protocol version rules for HardForkInitiation proposals, mirroring the
// Conway ledger's GOV rule preceedingHardFork: a proposal's protocol version
// is checked against its prev proposal's version, except when that prev is
// the enacted root (no open prev) or the resulting major jump would exceed
// the active version's major plus one, in which case it is checked against
// the active protocol version instead. Pure logic, no network.

/** A Cardano protocol version as a (major, minor) pair. */
export type ProtocolVersion = { major: number; minor: number };

/**
 * True when `to` is a valid successor of `from`: either the next major
 * version with minor reset to 0, or the same major with minor incremented
 * by one.
 */
export function follows(from: ProtocolVersion, to: ProtocolVersion): boolean {
  const isMajorBump = to.major === from.major + 1 && to.minor === 0;
  const isMinorBump = to.major === from.major && to.minor === from.minor + 1;
  return isMajorBump || isMinorBump;
}

/**
 * The protocol versions that may legally follow `base`, in order
 * major-bump then minor-bump, dropping the major-bump candidate when its
 * major would exceed the active version's major plus one. That drop is the
 * ledger's own guard against a base that is stale relative to the active
 * version (for example an open prev proposal several hard forks behind).
 */
export function versionsThatFollow(
  base: ProtocolVersion,
  active: ProtocolVersion,
): ProtocolVersion[] {
  const majorBump: ProtocolVersion = { major: base.major + 1, minor: 0 };
  const minorBump: ProtocolVersion = { major: base.major, minor: base.minor + 1 };
  const candidates = [majorBump, minorBump];
  return candidates.filter(c => c.major <= active.major + 1);
}

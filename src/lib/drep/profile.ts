// Pure view-model helpers for the DRep profile. No I/O.

/**
 * SEO quality-gate: a profile is indexable only when it carries real content,
 * so thousands of empty profiles do not become thin/duplicate pages. Thin
 * profiles stay reachable but are emitted noindex.
 */
export function isIndexableProfile(p: {
  hasMetadata: boolean;
  postCount: number;
  votesCast: number;
}): boolean {
  return p.hasMetadata || p.postCount > 0 || p.votesCast > 0;
}

/** A DRep's share of total active voting power, in percent, or null when unknown. */
export function influencePct(
  votingPowerLovelace: string | null,
  totalActiveLovelace: number,
): number | null {
  if (!votingPowerLovelace || totalActiveLovelace <= 0) return null;
  const power = Number(votingPowerLovelace);
  if (!Number.isFinite(power) || power <= 0) return null;
  return (power / totalActiveLovelace) * 100;
}

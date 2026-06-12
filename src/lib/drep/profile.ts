// Pure view-model helpers for the DRep profile. No I/O.

/**
 * Canonical profile path for a DRep: the SEO slug when one is assigned, else
 * the raw id. Every internal link goes through this so no link ever pays the
 * id-to-slug redirect.
 */
export function drepPath(d: { drepId: string; slug?: string | null }): string {
  return `/dreps/${d.slug ?? d.drepId}`;
}

/**
 * True when the requested path segment already is the canonical one for this
 * DRep; the profile routes 301 to drepPath() otherwise.
 */
export function isCanonicalDrepParam(
  d: { drepId: string; slug?: string | null },
  param: string,
): boolean {
  return param === (d.slug ?? d.drepId);
}

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

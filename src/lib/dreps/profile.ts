// Pure view-model helpers for the DRep profile. No I/O.

/**
 * Canonical profile path for a DRep: the SEO slug when one is assigned, else
 * the raw id. Every internal link goes through this so no link ever pays the
 * id-to-slug redirect.
 */
export function drepPath(d: { drepId: string; slug?: string | null }): string {
  return `/dreps/${d.slug ?? d.drepId}/`;
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
 * SEO quality-gate: a profile is indexable only when it carries a real identity
 * or human-written content (on-chain name/bio, or a forum post). A recorded vote
 * alone is not enough: a nameless drep whose only content is a votes table reads
 * as thin/near-duplicate to search engines and never ranks, so admitting those
 * hundreds of profiles only dilutes crawl budget. Thin profiles stay reachable
 * but are emitted noindex and kept out of the sitemap.
 */
export function isIndexableProfile(p: {
  hasMetadata: boolean;
  postCount: number;
}): boolean {
  return p.hasMetadata || p.postCount > 0;
}

/**
 * Meta description for a DRep profile, built from on-chain facts rather than the
 * free-text bio. Many DReps ship identical or empty CIP-119 bios, so a
 * bio-derived description reads as duplicate or thin across profiles, and the
 * raw text truncates mid-word. The templated form is unique per DRep (voting
 * power and vote count differ) and always reads cleanly. The bio still powers
 * the visible profile and its Person schema.
 */
export function drepMetaDescription(p: {
  displayName: string;
  votingPowerFormatted: string;
  votesCast: number;
  retired?: boolean;
}): string {
  const role = p.retired ? 'Retired Cardano DRep' : 'Cardano DRep';
  const votes =
    p.votesCast > 0
      ? `${p.votesCast} recorded on-chain ${p.votesCast === 1 ? 'vote' : 'votes'}`
      : 'no recorded on-chain votes yet';
  return `${p.displayName}: ${role} with ${p.votingPowerFormatted} voting power and ${votes}. See the full voting record, rationales, and delegation on DRepTalk.`;
}

/**
 * Human-readable summary paragraph for a DRep profile, composed from on-chain
 * facts. Rendered when the DRep has no free-text bio so the profile still
 * carries unique, substantive prose (registration, voting power, record,
 * participation) instead of only stat widgets. Every clause is guarded, so a
 * brand-new DRep with no votes still gets a clean, shorter summary.
 */
export function drepProfileSummary(p: {
  displayName: string;
  active: boolean;
  retired: boolean;
  registeredEpoch: number | null;
  votingPowerFormatted: string | null;
  influencePct: number | null;
  votesCast: number;
  breakdown: { yes: number; no: number; abstain: number };
  withRationale: number;
  participation: { eligible: number; voted: number } | null;
  forumPosts: number;
}): string {
  const name = p.displayName;
  const sentences: string[] = [];

  const role = p.retired ? 'a retired Cardano DRep' : p.active ? 'an active Cardano DRep' : 'a Cardano DRep';
  let intro = `${name} is ${role}`;
  if (p.registeredEpoch != null) intro += `, registered in epoch ${p.registeredEpoch}`;
  sentences.push(`${intro}.`);

  if (p.retired) {
    sentences.push('The credential has been deregistered on-chain and no longer holds voting power.');
  } else if (p.votingPowerFormatted) {
    let power = `They hold ${p.votingPowerFormatted} of delegated voting power`;
    if (p.influencePct != null) power += `, about ${p.influencePct.toFixed(2)}% of the active stake`;
    sentences.push(`${power}.`);
  }

  if (p.votesCast > 0) {
    const noun = p.votesCast === 1 ? 'vote' : 'votes';
    sentences.push(
      `${name} has cast ${p.votesCast} on-chain governance ${noun} (${p.breakdown.yes} yes, ${p.breakdown.no} no, ${p.breakdown.abstain} abstain).`,
    );
    if (p.participation && p.participation.eligible > 0) {
      const rate = Math.round((p.participation.voted / p.participation.eligible) * 100);
      sentences.push(
        `Since registering, they have taken part in ${p.participation.voted} of ${p.participation.eligible} decided actions (${rate}%).`,
      );
    }
    if (p.withRationale > 0) {
      const rnoun = p.withRationale === 1 ? 'rationale' : 'rationales';
      sentences.push(`They have published ${p.withRationale} ${rnoun} explaining their votes.`);
    }
  } else {
    sentences.push(`${name} has no recorded on-chain governance votes yet.`);
  }

  if (p.forumPosts > 0) {
    const pnoun = p.forumPosts === 1 ? 'post' : 'posts';
    sentences.push(`${name} has also contributed ${p.forumPosts} forum ${pnoun} on DRepTalk.`);
  }

  return sentences.join(' ');
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

/**
 * Display label for the share of active voting power. A tiny-but-real share
 * must never render as the broken-looking "0.00%": anything positive that
 * two-decimal rounding would flatten to zero reads "<0.01%" instead.
 */
export function formatSharePct(pct: number | null): string | null {
  if (pct == null || pct <= 0) return null;
  if (pct < 0.005) return '<0.01%';
  return `${pct.toFixed(2)}%`;
}

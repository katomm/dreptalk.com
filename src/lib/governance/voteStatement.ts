// Pure helpers for the shareable vote page: URL, index gate, vote-to-label map.
export const MIN_INDEXABLE_RATIONALE_CHARS = 240;

export function voteStatementPath(role: 'drep' | 'spo', voterKey: string, actionSlug: string): string {
  const base = role === 'spo' ? 'spos' : 'dreps';
  return `/${base}/${voterKey}/vote/${actionSlug}/`;
}

/**
 * Query+hash tail deep-linking one voter's row on an action's Positions tab:
 * `?tab=positions[&role=…][&voter=<id>]#voter-<id>`. Callers prepend their own
 * prefix (relative, absolute origin, or an actionHref). The voter= param and
 * the #voter- hash must carry the same id: the tab resolves voter= to the page
 * that currently renders the row (getActionVoterRank, the list reshuffles as
 * votes arrive), the hash drives the scroll/expand/highlight on arrival. The
 * CC list is unpaginated, so cc links omit voter= and keep the plain anchor;
 * if the CC list ever paginates, add voter= here and resolve it like the
 * other roles. Omitting role means the default DRep sub-section.
 */
export function positionsVoterAnchor(voterId: string, role?: 'spo' | 'cc'): string {
  const rolePart = role ? `&role=${role}` : '';
  const voterPart = role === 'cc' ? '' : `&voter=${voterId}`;
  return `?tab=positions${rolePart}${voterPart}#voter-${voterId}`;
}

export function isVoteStatementIndexable(args: { hasMetadata: boolean; rationaleText: string }): boolean {
  return args.hasMetadata && args.rationaleText.trim().length >= MIN_INDEXABLE_RATIONALE_CHARS;
}

export function voteDisplay(vote: string): { label: string; tone: 'yes' | 'no' | 'abstain' | 'other' } {
  // Case-insensitive: synced votes are stored capitalized ("Yes"), but an
  // optimistic just-cast vote is stored lowercase ("yes"), and both must render
  // the same on the preview card. Mirrors voteTone's lowercase normalization.
  const v = vote.trim().toLowerCase();
  if (v === 'yes') return { label: 'VOTED YES', tone: 'yes' };
  if (v === 'no') return { label: 'VOTED NO', tone: 'no' };
  if (v === 'abstain') return { label: 'ABSTAINED', tone: 'abstain' };
  return { label: 'VOTED', tone: 'other' };
}

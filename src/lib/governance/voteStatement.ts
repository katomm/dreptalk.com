// Pure helpers for the shareable vote page: URL, index gate, vote-to-label map.
export const MIN_INDEXABLE_RATIONALE_CHARS = 240;

export function voteStatementPath(role: 'drep' | 'spo', voterKey: string, actionSlug: string): string {
  const base = role === 'spo' ? 'spos' : 'dreps';
  return `/${base}/${voterKey}/vote/${actionSlug}/`;
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

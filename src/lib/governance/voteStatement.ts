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
  if (vote === 'Yes') return { label: 'VOTED YES', tone: 'yes' };
  if (vote === 'No') return { label: 'VOTED NO', tone: 'no' };
  if (vote === 'Abstain') return { label: 'ABSTAINED', tone: 'abstain' };
  return { label: 'VOTED', tone: 'other' };
}

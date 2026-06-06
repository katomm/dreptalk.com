export type CategoryKind = 'governance' | 'discussion';

export interface Category {
  slug: string;
  name: string;
  description: string;
  kind: CategoryKind;
  position: number;
}

export const CATEGORIES: Category[] = [
  { slug: 'governance-actions', name: 'Governance Actions', description: 'On-chain governance actions, one thread each, opened automatically.', kind: 'governance', position: 1 },
  { slug: 'constitution', name: 'Constitution and Guardrails', description: 'The Cardano Constitution, guardrails, and amendments.', kind: 'discussion', position: 2 },
  { slug: 'budget', name: 'Budget and Treasury', description: 'Treasury withdrawals and the budget process.', kind: 'discussion', position: 3 },
  { slug: 'general', name: 'General and Off-topic', description: 'General Cardano governance discussion.', kind: 'discussion', position: 4 },
];

export const GOVERNANCE_CATEGORY_SLUG = 'governance-actions';

// Pre-sorted once at module load; avoids repeated sort on every getCategories() call.
const SORTED_CATEGORIES: readonly Category[] = [...CATEGORIES].sort((a, b) => a.position - b.position);

export function getCategories(): readonly Category[] {
  return SORTED_CATEGORIES;
}

export function getCategory(slug: string): Category | undefined {
  return CATEGORIES.find((c) => c.slug === slug);
}

export function isDiscussion(slug: string): boolean {
  const c = getCategory(slug);
  return !!c && c.kind === 'discussion';
}

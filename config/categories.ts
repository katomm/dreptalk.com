// 'governance' and 'survey' categories are system-fed (one thread per synced
// on-chain object, read-only at the category level); 'discussion' categories
// take user topics. Consumers branching on the kind must not answer questions
// about surveys nobody asked — hence a kind of its own, not 'governance'.
export type CategoryKind = 'governance' | 'discussion' | 'survey';

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
  { slug: 'surveys', name: 'Surveys', description: 'On-chain CIP-179 surveys linked to governance actions, one thread each, opened automatically.', kind: 'survey', position: 5 },
];

export const GOVERNANCE_CATEGORY_SLUG = 'governance-actions';
export const BUDGET_CATEGORY_SLUG = 'budget';
export const SURVEYS_CATEGORY_SLUG = 'surveys';

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

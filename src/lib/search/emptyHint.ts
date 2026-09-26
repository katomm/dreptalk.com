import type { Scope } from './scopes.js';
import type { SearchCounts } from './handler.js';
import type { RowScope } from './paletteFilter.js';

export interface OtherScopeHit {
  scope: Exclude<Scope, 'all'>;
  count: number;
}

// Stable, human-facing order for the hint (matches the facet column order).
const HINT_ORDER: readonly Exclude<Scope, 'all'>[] = ['governance', 'forum', 'dreps', 'rationales', 'reviews', 'help'];

/** The non-active scopes that have at least one hit, for the "/search" page's
 *  empty-filter hint. Empty when the active scope is "all" or counts are absent. */
export function otherScopesWithCounts(counts: SearchCounts | null, active: Scope): OtherScopeHit[] {
  if (active === 'all' || !counts) return [];
  return HINT_ORDER.filter((s) => s !== active && counts[s] > 0).map((s) => ({ scope: s, count: counts[s] }));
}

/** The non-active scopes that currently have palette rows, for the palette's
 *  empty-filter hint. The exact match and page rows belong to no filter and
 *  are ignored. Empty when the active scope is "all". */
export function otherScopesWithRows(rows: Array<{ scope: RowScope }>, active: Scope): Exclude<Scope, 'all'>[] {
  if (active === 'all') return [];
  const seen = new Set(rows.map((r) => r.scope));
  return HINT_ORDER.filter((s) => s !== active && seen.has(s));
}

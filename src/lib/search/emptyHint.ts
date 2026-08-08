import { groupToScope, type Scope } from './scopes.js';
import type { ScopeCounts } from '../db/search.js';

export interface OtherScopeHit {
  scope: Exclude<Scope, 'all'>;
  count: number;
}

// Stable, human-facing order for the hint (matches the facet column order).
const HINT_ORDER: readonly Exclude<Scope, 'all'>[] = ['governance', 'forum', 'dreps', 'rationales', 'help'];

/** The non-active scopes that have at least one hit, for the "/search" page's
 *  empty-filter hint. Empty when the active scope is "all" or counts are absent.
 *  Help lives outside ScopeCounts (a client-side index), so its count is passed
 *  separately. */
export function otherScopesWithCounts(counts: ScopeCounts | null, helpCount: number | null, active: Scope): OtherScopeHit[] {
  if (active === 'all' || !counts) return [];
  const byScope: Record<Exclude<Scope, 'all'>, number> = {
    governance: counts.governance,
    forum: counts.forum,
    dreps: counts.dreps,
    rationales: counts.rationales,
    help: helpCount ?? 0,
  };
  return HINT_ORDER.filter((s) => s !== active && byScope[s] > 0).map((s) => ({ scope: s, count: byScope[s] }));
}

/** The non-active scopes that currently have palette rows, for the palette's
 *  empty-filter hint. The synthetic "Exact match" group maps to "all" and is
 *  ignored. Empty when the active scope is "all". */
export function otherScopesWithRows(rows: Array<{ group: string }>, active: Scope): Exclude<Scope, 'all'>[] {
  if (active === 'all') return [];
  const seen = new Set<Scope>();
  for (const r of rows) seen.add(groupToScope(r.group));
  return HINT_ORDER.filter((s) => s !== active && seen.has(s));
}

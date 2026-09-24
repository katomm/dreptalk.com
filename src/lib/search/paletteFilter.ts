import type { Scope } from './scopes.js';

/** A palette row's filter scope. null marks the synthetic "Exact match" row (a
 *  resolved id), which stays visible whatever filter pill is active. Page
 *  shortcuts carry "all", so they show only under the "All" pill. */
export type RowScope = Scope | null;

/** Filters palette rows to a scope. "all" keeps everything, otherwise the
 *  exact match and the rows of that scope survive. */
export function filterRowsByScope<T extends { scope: RowScope }>(rows: T[], scope: Scope): T[] {
  if (scope === 'all') return rows;
  return rows.filter((r) => r.scope === null || r.scope === scope);
}

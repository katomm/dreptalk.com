import { groupToScope, type Scope } from './scopes.js';

/** Filters palette rows to a scope. "all" keeps everything. The synthetic
 *  "Exact match" group (a resolved id) is scope-independent and always kept, so
 *  a pasted id stays visible whatever filter pill is active. Otherwise only rows
 *  whose group maps to the given scope survive. */
export function filterRowsByScope<T extends { group: string }>(rows: T[], scope: Scope): T[] {
  if (scope === 'all') return rows;
  return rows.filter((r) => r.group === 'Exact match' || groupToScope(r.group) === scope);
}

import { groupToScope, type Scope } from './scopes.js';

/** Filters palette rows to a scope. "all" keeps everything; otherwise only rows
 *  whose group maps to the given scope survive. */
export function filterRowsByScope<T extends { group: string }>(rows: T[], scope: Scope): T[] {
  if (scope === 'all') return rows;
  return rows.filter((r) => groupToScope(r.group) === scope);
}

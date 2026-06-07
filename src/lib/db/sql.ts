/// <reference types="@cloudflare/workers-types" />
// Small shared helpers for parameterized D1 SQL.

/**
 * Builds a comma-separated list of `?` placeholders for a parameterized IN clause,
 * one per id. The caller still passes the ids to .bind(...ids) itself, so SQL stays
 * fully parameterized. Example: sqlPlaceholders(['a','b']) -> "?, ?".
 */
export function sqlPlaceholders(ids: readonly unknown[]): string {
  return ids.map(() => '?').join(', ');
}

/// <reference types="@cloudflare/workers-types" />
// Small shared helpers for parameterized D1 SQL.
import { CONCLUDED_STATUSES } from '../governance/view.js';

/**
 * Builds a comma-separated list of `?` placeholders for a parameterized IN clause,
 * one per id. The caller still passes the ids to .bind(...ids) itself, so SQL stays
 * fully parameterized. Example: sqlPlaceholders(['a','b']) -> "?, ?".
 */
export function sqlPlaceholders(ids: readonly unknown[]): string {
  return ids.map(() => '?').join(', ');
}

/**
 * D1 rejects a statement with more than 100 bound parameters ("too many SQL
 * variables"). Chunk unbounded id lists so placeholders plus any fixed binds
 * stay at or under this cap per statement.
 */
export const D1_MAX_BINDS = 100;

/** Splits xs into consecutive runs of at most `size` elements (the last may be shorter). */
export function chunked<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size) as T[]);
  return out;
}

/**
 * SQL predicate for "this action's voting window ran its course", for the
 * given table alias. Built from CONCLUDED_STATUSES so the SQL and in-memory
 * definitions cannot drift; the values are compile-time constants from that
 * list, never caller input, so inlining them keeps call sites free of extra
 * binds. Use it in every read whose count answers "of the actions you could
 * have voted on", never `decided_epoch IS NOT NULL` alone.
 */
export function concludedStatusSql(alias: string): string {
  return `${alias}.status IN (${CONCLUDED_STATUSES.map((s) => `'${s}'`).join(', ')})`;
}

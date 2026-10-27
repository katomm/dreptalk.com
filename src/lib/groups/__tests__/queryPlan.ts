/// <reference types="@cloudflare/workers-types" />
// Reads SQLite query plans of registered statements and names every step that is not a seek
// through an index. Test only.
import type { RegisteredQuery } from '../store/queries.js';

/** Names declared in WITH clauses, the key lists a statement may scan. */
export function declaredCtes(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)(\w+)\s*(?:\([^)]*\))?\s+AS\s*\(/gi)) out.add(m[1]);
  return out;
}

/**
 * Every plan step that scans a table or sorts: a SCAN that is neither a declared CTE nor the
 * declared bounded scan, and every temp b-tree. A bounded scan walks the named index of a
 * keyset read with ORDER BY and LIMIT. A scan of constant rows reads the VALUES list itself.
 */
export function unboundedScans(q: RegisteredQuery, planDetails: string[]): string[] {
  const ctes = declaredCtes(q.sql);
  const keyset = /\bORDER\s+BY\b/i.test(q.sql) && /\bLIMIT\b/i.test(q.sql);
  return planDetails.filter((d) => {
    if (/^USE TEMP B-TREE\b/.test(d)) return true;
    const scan = /^SCAN (\S+)(?: USING (?:COVERING )?INDEX (\S+))?/.exec(d);
    if (!scan) return false;
    if (/^SCAN (?:\d+ )?CONSTANT ROWS?$/.test(d)) return false;
    if (ctes.has(scan[1]) && scan[2] === undefined) return false;
    return !(keyset && q.boundedScan !== undefined && scan[2] === q.boundedScan);
  });
}

/** The plan details of a statement with its binds. */
export async function planOf(db: D1Database, sql: string, binds: unknown[]): Promise<string[]> {
  const r = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
  return (r.results ?? []).map((x) => x.detail);
}

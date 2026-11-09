// The D1 reset of the Workers-runtime tests. The setup file captures the migrated state once per
// test file and restores it before every test. A test that needs a fresh database in the middle of
// its run calls resetD1 itself.
import { env } from 'cloudflare:test';

// Snapshot of the post-migration D1 state (table name plus its seed rows),
// captured once per test file and restored by resetD1.
let d1Seed: { table: string; rows: Record<string, unknown>[] }[] = [];

// The user-table list is fixed once migrations have run, so it is resolved once
// per test file instead of being re-queried before every test.
let tableNames: string[] = [];

// User tables only: excludes SQLite internals, Cloudflare internals, the
// migration-tracking table, and the FTS5 virtual tables plus their shadow
// tables. FTS tables cannot be cleared with a direct DELETE (external
// content). Deleting the source rows fires the sync triggers instead, which
// empties the index correctly.
async function userTables(): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' " +
      "AND name NOT LIKE '%\\_fts' ESCAPE '\\' AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\'",
  ).all<{ name: string }>();
  return result.results.map((r) => r.name);
}

/** Captures the user tables and their migration seed rows. Runs once the migrations are applied. */
export async function captureD1Seed(): Promise<void> {
  tableNames = await userTables();
  const seeded = await env.DB.batch<Record<string, unknown>>(
    tableNames.map((table) => env.DB.prepare(`SELECT * FROM "${table}"`)),
  );
  d1Seed = tableNames
    .map((table, i) => ({ table, rows: seeded[i].results ?? [] }))
    .filter((entry) => entry.rows.length > 0);
}

/** Clears every user table and restores the captured seed rows, in one batch. */
export async function resetD1(): Promise<void> {
  if (tableNames.length === 0) throw new Error('the D1 seed was not captured');
  const reset = tableNames.map((table) => env.DB.prepare(`DELETE FROM "${table}"`));
  // Restore the migration seed rows captured after migrations ran.
  for (const { table, rows } of d1Seed) {
    for (const row of rows) {
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      const columnList = cols.map((c) => `"${c}"`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      reset.push(
        env.DB.prepare(`INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`).bind(
          ...cols.map((c) => row[c]),
        ),
      );
    }
  }
  await env.DB.batch(reset);
}

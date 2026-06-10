// Global setup for Workers-runtime tests.
// Applies D1 migrations before each test suite so every test starts with a fresh schema.
import { env, applyD1Migrations, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

declare module 'cloudflare:test' {
  // Extend the env type with bindings defined in wrangler.toml plus the
  // test-only migration payload injected by vitest.workers.config.ts.
  interface ProvidedEnv {
    DB: D1Database;
    SESSIONS: KVNamespace;
    NONCES: KVNamespace;
    AVATARS: R2Bucket;
    RATE_LIMITER: DurableObjectNamespace<import('./rateLimiterDO.js').RateLimiter>;
    TEST_D1_MIGRATIONS: string;
  }
}

// Snapshot of the post-migration D1 state (table name plus its seed rows),
// captured once per test file and restored before each test (see beforeEach).
let d1Seed: { table: string; rows: Record<string, unknown>[] }[] = [];

// User tables only: excludes SQLite internals, Cloudflare internals, the
// migration-tracking table, and the FTS5 virtual tables plus their shadow
// tables. FTS tables cannot be cleared with a direct DELETE (external
// content); deleting the source rows fires the sync triggers instead, which
// empties the index correctly.
async function userTables(): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' " +
      "AND name NOT LIKE '%\\_fts' ESCAPE '\\' AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\'",
  ).all<{ name: string }>();
  return result.results.map((r) => r.name);
}

beforeAll(async () => {
  // TEST_D1_MIGRATIONS is a JSON-serialized D1Migration[] injected from the Node.js
  // config context via vitest.workers.config.ts using readD1Migrations().
  const migrations = JSON.parse(env.TEST_D1_MIGRATIONS as string) as import('cloudflare:test').D1Migration[];
  await applyD1Migrations(env.DB, migrations);

  // Capture migration-seeded rows (e.g. the 'system' user) so the per-test reset
  // can restore them rather than wipe them.
  d1Seed = [];
  for (const table of await userTables()) {
    const { results } = await env.DB.prepare(`SELECT * FROM "${table}"`).all<Record<string, unknown>>();
    d1Seed.push({ table, rows: results });
  }
});

beforeEach(async () => {
  // pool-workers 0.16 / vitest 4 dropped the per-test storage rollback that older
  // versions did automatically. Reset D1 tables and KV namespaces before every test
  // so each one starts from the migrated-and-seeded state the suite was written against.
  // This runs before any test-file beforeEach, so files that seed their own fixtures
  // (e.g. stakeParticipation) still see a clean slate first.
  for (const table of await userTables()) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
  // Restore the migration seed rows captured after migrations ran.
  for (const { table, rows } of d1Seed) {
    for (const row of rows) {
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      const columnList = cols.map((c) => `"${c}"`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      await env.DB.prepare(`INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`)
        .bind(...cols.map((c) => row[c]))
        .run();
    }
  }

  for (const ns of [env.SESSIONS, env.NONCES]) {
    const { keys } = await ns.list();
    await Promise.all(keys.map((k) => ns.delete(k.name)));
  }

  // Clear the R2 avatar bucket so each test starts with an empty bucket.
  // R2 objects are not reset automatically by the workers pool.
  const listed = await env.AVATARS.list();
  await Promise.all(listed.objects.map((obj) => env.AVATARS.delete(obj.key)));

  // Reset RateLimiter Durable Object storage so rate-limit windows never leak
  // between tests (the manual analogue of the per-test rollback pool-workers 0.16
  // dropped, the same reason D1 and KV are wiped above).
  for (const id of await listDurableObjectIds(env.RATE_LIMITER)) {
    await runInDurableObject(env.RATE_LIMITER.get(id), (_instance, state) => state.storage.deleteAll());
  }
});

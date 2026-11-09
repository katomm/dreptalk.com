// Global setup for Workers-runtime tests.
// Applies D1 migrations before each test suite so every test starts with a fresh schema.
import { env, applyD1Migrations, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';
import { captureD1Seed, resetD1 } from './test-d1-reset.workers.js';

declare module 'cloudflare:test' {
  // Extend the env type with bindings defined in wrangler.toml plus the
  // test-only migration payload injected by vitest.workers.config.ts.
  interface ProvidedEnv {
    DB: D1Database;
    SESSIONS: KVNamespace;
    AVATARS: R2Bucket;
    RATE_LIMITER: DurableObjectNamespace<import('./rateLimiterDO.js').RateLimiter>;
    TEST_D1_MIGRATIONS: string;
    DREPTALK_CONFORMANCE_SEEDS: string;
  }
}

beforeAll(async () => {
  // TEST_D1_MIGRATIONS is a JSON-serialized D1Migration[] injected from the Node.js
  // config context via vitest.workers.config.ts using readD1Migrations().
  const migrations = JSON.parse(env.TEST_D1_MIGRATIONS as string) as import('cloudflare:test').D1Migration[];
  await applyD1Migrations(env.DB, migrations);

  // Capture migration-seeded rows (e.g. the 'system' user) so the per-test reset
  // can restore them rather than wipe them.
  await captureD1Seed();
});

beforeEach(async () => {
  // pool-workers 0.16 / vitest 4 dropped the per-test storage rollback that older
  // versions did automatically. Reset D1 tables and KV namespaces before every test
  // so each one starts from the migrated-and-seeded state the suite was written against.
  // This runs before any test-file beforeEach, so files that seed their own fixtures
  // (e.g. stakeParticipation) still see a clean slate first.
  // One batch rather than a statement per table: the reset runs before every
  // test, so ~34 sequential round trips each time dominated the suite runtime.
  await resetD1();

  {
    const { keys } = await env.SESSIONS.list();
    await Promise.all(keys.map((k) => env.SESSIONS.delete(k.name)));
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

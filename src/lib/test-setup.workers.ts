// Global setup for Workers-runtime tests.
// Applies D1 migrations before each test suite so every test starts with a fresh schema.
import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll } from 'vitest';

declare module 'cloudflare:test' {
  // Extend the env type with bindings defined in wrangler.toml plus the
  // test-only migration payload injected by vitest.workers.config.ts.
  interface ProvidedEnv {
    DB: D1Database;
    SESSIONS: KVNamespace;
    NONCES: KVNamespace;
    TEST_D1_MIGRATIONS: string;
  }
}

beforeAll(async () => {
  // TEST_D1_MIGRATIONS is a JSON-serialized D1Migration[] injected from the Node.js
  // config context via vitest.workers.config.ts using readD1Migrations().
  const migrations = JSON.parse(env.TEST_D1_MIGRATIONS as string) as import('cloudflare:test').D1Migration[];
  await applyD1Migrations(env.DB, migrations);
});

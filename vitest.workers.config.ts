import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Vitest 4 / pool-workers 0.16: the old defineWorkersProject + poolOptions.workers
// shape is replaced by the cloudflareTest() plugin. The previous worker pool
// options object is now passed straight to cloudflareTest().
export default defineConfig(async () => {
  // Read migrations in Node.js context; serialized and injected into the Workers runtime
  // as a plain text binding so the setup file can call applyD1Migrations.
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, 'migrations'),
  );

  return {
    plugins: [
      cloudflareTest({
        // Bindings are declared inline so the pool does NOT read wrangler.toml.
        // wrangler.toml has [assets] directory = "./dist/client" which fails
        // validation in CI because no build is run before tests. The tests
        // import library functions directly and never serve static assets, so
        // the [assets] block is irrelevant here.
        main: './src/lib/test-worker-entry.ts',
        miniflare: {
          compatibilityDate: '2025-09-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          kvNamespaces: ['SESSIONS', 'NONCES'],
          durableObjects: { RATE_LIMITER: 'RateLimiter' },
          bindings: {
            // Pass serialized migration data so the setup file can apply them.
            TEST_D1_MIGRATIONS: JSON.stringify(migrations),
          },
        },
      }),
    ],
    test: {
      name: 'workers',
      include: ['src/**/*.workers.test.ts'],
      setupFiles: ['./src/lib/test-setup.workers.ts'],
    },
    resolve: {
      alias: { '@': new URL('./src', import.meta.url).pathname },
    },
  };
});

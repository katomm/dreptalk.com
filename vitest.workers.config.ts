import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Tests must run under the same runtime compatibility date as the deployed
// worker, so read it from wrangler.toml instead of pinning a copy here (the
// pool cannot consume wrangler.toml wholesale, see the [assets] note below).
// compatDate.test.ts guards the app and gov-sync tomls against drifting apart.
function deployCompatibilityDate(): string {
  const toml = readFileSync(path.join(import.meta.dirname, 'wrangler.toml'), 'utf8');
  const match = toml.match(/^compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"/m);
  if (!match) throw new Error('compatibility_date not found in wrangler.toml');
  return match[1];
}

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
          compatibilityDate: deployCompatibilityDate(),
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          kvNamespaces: ['SESSIONS'],
          r2Buckets: ['AVATARS'],
          // Images binding: the pool serves the low-fidelity offline version,
          // which covers the width/height/format transform the OG renditions use.
          images: { binding: 'IMAGES' },
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

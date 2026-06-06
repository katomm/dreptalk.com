import path from 'node:path';
import { defineWorkersProject, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersProject(async () => {
  // Read migrations in Node.js context; serialized and injected into the Workers runtime
  // as a plain text binding so the setup file can call applyD1Migrations.
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, 'migrations'),
  );

  return {
    test: {
      name: 'workers',
      include: ['src/**/*.workers.test.ts'],
      setupFiles: ['./src/lib/test-setup.workers.ts'],
      poolOptions: {
        workers: {
          // Bindings (D1 DB, KV SESSIONS/NONCES) and migrations are read from
          // wrangler.toml. Override `main` so the pool does not try to resolve
          // the production entrypoint (`@astrojs/cloudflare/entrypoints/server`),
          // a bare package specifier the pool cannot load as a file. The tests
          // import library functions directly and never fetch the SSR worker.
          main: './src/lib/test-worker-entry.ts',
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            bindings: {
              // Pass serialized migration data so the setup file can apply them.
              TEST_D1_MIGRATIONS: JSON.stringify(migrations),
            },
          },
        },
      },
    },
    resolve: {
      alias: { '@': new URL('./src', import.meta.url).pathname },
    },
  };
});

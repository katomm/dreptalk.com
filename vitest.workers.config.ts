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

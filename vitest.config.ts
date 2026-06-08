import { defineConfig } from 'vitest/config';

// Two projects: pure Node.js tests and Workers-runtime integration tests.
// Vitest 4 dropped the separate workspace file in favour of `test.projects`,
// so this single config is the canonical entry point for `vitest run`.
export default defineConfig({
  test: {
    projects: [
      // Node environment: pure-logic tests (no bindings needed).
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'config/**/*.test.ts'],
          exclude: ['src/**/*.workers.test.ts', 'node_modules/**'],
        },
        resolve: {
          alias: { '@': new URL('./src', import.meta.url).pathname },
        },
      },
      // Workers runtime: binding-dependent tests, using miniflare under the hood.
      './vitest.workers.config.ts',
    ],
  },
});

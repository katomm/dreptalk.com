import { defineWorkspace } from 'vitest/config';

// Two projects: pure Node.js tests and Workers-runtime integration tests.
export default defineWorkspace([
  // Node environment: existing pure-logic tests (no bindings needed).
  {
    test: {
      name: 'node',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['src/**/*.workers.test.ts', 'node_modules/**'],
    },
    resolve: {
      alias: { '@': new URL('./src', import.meta.url).pathname },
    },
  },
  // Workers runtime: binding-dependent tests, using miniflare under the hood.
  'vitest.workers.config.ts',
]);

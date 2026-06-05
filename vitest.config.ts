import { defineConfig } from 'vitest/config';

// Root config: delegates to vitest.workspace.ts when workspaces are used.
// Kept for standalone `vitest run` fallback; the workspace config is the
// canonical entry point for `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.workers.test.ts', 'node_modules/**'],
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});

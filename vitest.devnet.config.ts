import { defineConfig } from 'vitest/config';

// Devnet tests start cardano-node, Kupo and Ogmios in Docker through
// @evolution-sdk/devnet. They run only through `npm run test:devnet`, never
// in the default suite or CI, so `npm test` never needs Docker.
export default defineConfig({
  test: {
    name: 'devnet',
    environment: 'node',
    include: ['src/**/*.devnet.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});

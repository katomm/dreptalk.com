import { defineConfig } from '@playwright/test';
import { assertDevVars, currentTier } from './dev-vars.js';

const tier = currentTier();
const PORT = Number(process.env.E2E_PORT ?? 4321);
const KOIOS_PORT = Number(process.env.E2E_KOIOS_PORT ?? 4399);

assertDevVars(tier, KOIOS_PORT);

if (tier !== 'mock' && !process.env.PREPROD_TEST_WALLET_MNEMONIC) {
  // Fails instead of skipping, so a chain run can never pass with nothing run.
  throw new Error(`DREPTALK_E2E_CHAIN=${tier} needs PREPROD_TEST_WALLET_MNEMONIC in the environment`);
}

// A chain-write spec spends real test funds and deposits, so a write run takes
// exactly one spec file named on the command line, never a whole folder.
if (tier === 'write' && process.argv.filter((a) => a.endsWith('.spec.ts')).length !== 1) {
  throw new Error('DREPTALK_E2E_CHAIN=write runs exactly one spec file, name it on the command line');
}

const devServer = {
  command: `npm run dev -- --host 127.0.0.1 --port ${PORT}`,
  cwd: '..',
  url: `http://127.0.0.1:${PORT}/login`,
  timeout: 180_000,
};

const koiosFixture = {
  command: 'node koios-fixture/server.ts',
  url: `http://127.0.0.1:${KOIOS_PORT}/__fixture/misses`,
  env: { E2E_KOIOS_PORT: String(KOIOS_PORT) },
  timeout: 15_000,
};

// One worker: the fixture server holds one scenario at a time.
export default defineConfig({
  testDir: tier === 'mock' ? 'tests' : 'tests/chain',
  testIgnore: tier === 'mock' ? 'chain/**' : undefined,
  timeout: 90_000,
  workers: 1,
  outputDir: '../test-results',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // The app rate-limits per client IP, which it reads from cf-connecting-ip.
    // Locally nothing sets that header, so every request would share one
    // bucket that also outlives the run. A per-run value gives each run its
    // own, the mock tier's fixture narrows it to one per test.
    extraHTTPHeaders: { 'cf-connecting-ip': `e2e-run-${Date.now()}` },
    // Chain runs use the real test wallet, and its keys end up in traces.
    trace: tier === 'mock' ? 'retain-on-failure' : 'off',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' }, grep: /@both-engines/ },
  ],
  webServer: tier === 'mock' ? [koiosFixture, devServer] : [devServer],
});

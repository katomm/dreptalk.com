import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export type Tier = 'mock' | 'read' | 'write';

/** The test tier from DREPTALK_E2E_CHAIN: unset is the mock tier, `read` and `write` reach preprod. */
export function currentTier(): Tier {
  const value = process.env.DREPTALK_E2E_CHAIN ?? '';
  if (value === '') return 'mock';
  if (value === 'read' || value === 'write') return value;
  throw new Error(`DREPTALK_E2E_CHAIN must be unset, "read" or "write", got "${value}"`);
}

// The app reads its bindings from wrangler.toml plus the local .dev.vars file.
// Unset CARDANO_NETWORK means mainnet, and a preprod wallet then fails with a
// network mismatch instead of the path under test. The mock tier also needs
// KOIOS_BASE_URL on the fixture server, the chain tiers must not have it, or
// they would quietly read fixtures. Called while the Playwright config loads,
// before the dev server starts.
export function assertDevVars(tier: Tier, koiosPort: number): void {
  const file = resolve(import.meta.dirname, '..', '.dev.vars');
  if (!existsSync(file)) {
    throw new Error(`missing ${file}. Copy e2e/dev.vars.example to .dev.vars in the repository root before running the e2e tests.`);
  }
  const vars = parseEnv(readFileSync(file, 'utf8'));
  if (vars.CARDANO_NETWORK !== 'preprod') {
    throw new Error(`${file} must set CARDANO_NETWORK=preprod for the e2e tests.`);
  }
  const override = vars.KOIOS_BASE_URL;
  if (tier === 'mock') {
    const expected = `http://127.0.0.1:${koiosPort}/api/v1`;
    if (override !== expected) {
      throw new Error(`${file} must set KOIOS_BASE_URL=${expected} for the mock tier (see e2e/dev.vars.example).`);
    }
  } else if (override) {
    throw new Error(`${file} sets KOIOS_BASE_URL, remove it for a chain run, the dev server would read fixtures instead of preprod.`);
  }
}

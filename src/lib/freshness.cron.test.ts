// Drift guard: the gov-sync worker dispatches on `event.cron` against the
// CRON_* constants in freshness.ts (via resolveCronKind), but Cloudflare
// triggers the worker from the `crons` arrays in workers/gov-sync/wrangler.toml.
// Those two lists are wired by hand: a stray toml expression makes the worker
// refuse the run at runtime (resolveCronKind returns null), and this test makes
// the same drift fail CI first. It reads the toml and asserts every `crons`
// array (top-level mainnet and every `[env.*]` block) matches the constants.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CRON_GOVERNANCE, CRON_VOTE_SYNC, CRON_DREP_SYNC, resolveCronKind } from './freshness.js';

const WRANGLER_TOML = fileURLToPath(
  new URL('../../workers/gov-sync/wrangler.toml', import.meta.url),
);

// The full set of cron expressions the worker knows how to dispatch.
const EXPECTED = [CRON_GOVERNANCE, CRON_VOTE_SYNC, CRON_DREP_SYNC].sort();

// Extract every `crons = [ ... ]` array from the toml as a sorted string list.
// A light regex is enough here (no toml dependency): the array is always inline
// and the values are simple quoted cron strings.
function parseCronArrays(toml: string): string[][] {
  const arrays: string[][] = [];
  for (const match of toml.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)) {
    const values = [...match[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
    arrays.push(values.sort());
  }
  return arrays;
}

describe('gov-sync cron config', () => {
  const toml = readFileSync(WRANGLER_TOML, 'utf8');
  const cronArrays = parseCronArrays(toml);

  it('declares the mainnet and preprod cron arrays', () => {
    // Top-level [triggers] plus [env.preprod.triggers]: both must be present so
    // the preprod mirror keeps the same cadence as mainnet.
    expect(cronArrays.length).toBeGreaterThanOrEqual(2);
  });

  it('matches every crons array to the dispatch constants in freshness.ts', () => {
    for (const crons of cronArrays) {
      expect(crons).toEqual(EXPECTED);
    }
  });
});

describe('resolveCronKind', () => {
  it('maps each configured cron expression to its sync kind', () => {
    expect(resolveCronKind(CRON_GOVERNANCE)).toBe('governance');
    expect(resolveCronKind(CRON_VOTE_SYNC)).toBe('votes');
    expect(resolveCronKind(CRON_DREP_SYNC)).toBe('dreps');
  });

  it('returns null for an unknown cron expression instead of falling back to a default run', () => {
    expect(resolveCronKind('*/7 * * * *')).toBe(null);
    expect(resolveCronKind('')).toBe(null);
  });
});

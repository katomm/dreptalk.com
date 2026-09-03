import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Drift guard: the app worker and the gov-sync worker each carry their own
// copy of the deploy vars that must agree per environment. Mainnet's copies
// are the two top-level [vars] blocks; preprod's are scripts/preprod-config.mjs
// (the adapter drops [env.*] from the app toml, so that script derives the
// preprod config) and the gov-sync [env.preprod.vars] block. A value set on
// one side only is a live defect, not a config nit: TESSERA_BACKEND_URL on the
// app alone offers survey answers nothing settles, on gov-sync alone mirrors
// surveys nobody can see; a VAPID key mismatch sends pushes the subscription
// cannot verify. Absent on both sides is a legitimate state (the surveys
// switch is deliberately off on mainnet), so the assertion is equality, with
// the always-present VAPID key proving the parsers actually match something.

const KEYS = ['CARDANO_NETWORK', 'VAPID_PUBLIC_KEY', 'TESSERA_BACKEND_URL'] as const;

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

/** `key` inside the `[section]` block of a wrangler TOML, or null when unset there. */
function tomlVar(path: string, section: string, key: string): string | null {
  let current = '';
  for (const line of read(path).split('\n')) {
    const header = line.match(/^\[([^\]]+)\]/);
    if (header) {
      current = header[1];
      continue;
    }
    const kv = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`));
    if (kv && current === section) return kv[1];
  }
  return null;
}

/** `key` in the `cfg.vars` literal of the preprod derivation script, or null. */
function preprodAppVar(key: string): string | null {
  const m = read('scripts/preprod-config.mjs').match(new RegExp(`^\\s*${key}:\\s*'([^']*)'`, 'm'));
  return m ? m[1] : null;
}

describe('deploy vars lockstep', () => {
  it('both parsers find the VAPID key on both environments', () => {
    expect(tomlVar('wrangler.toml', 'vars', 'VAPID_PUBLIC_KEY')).not.toBeNull();
    expect(tomlVar('workers/gov-sync/wrangler.toml', 'vars', 'VAPID_PUBLIC_KEY')).not.toBeNull();
    expect(preprodAppVar('VAPID_PUBLIC_KEY')).not.toBeNull();
    expect(
      tomlVar('workers/gov-sync/wrangler.toml', 'env.preprod.vars', 'VAPID_PUBLIC_KEY'),
    ).not.toBeNull();
  });

  it.each(KEYS)('mainnet: the app and gov-sync agree on %s', key => {
    expect(tomlVar('workers/gov-sync/wrangler.toml', 'vars', key)).toBe(
      tomlVar('wrangler.toml', 'vars', key),
    );
  });

  it.each(KEYS)('preprod: the app and gov-sync agree on %s', key => {
    expect(tomlVar('workers/gov-sync/wrangler.toml', 'env.preprod.vars', key)).toBe(
      preprodAppVar(key),
    );
  });
});

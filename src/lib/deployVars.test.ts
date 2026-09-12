import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Drift guard: the app worker and the gov-sync worker each carry their own
// copy of the deploy vars that must agree per environment. Mainnet's copies
// are the two top-level [vars] blocks; preprod's are scripts/preprod-config.mjs
// (the adapter drops [env.*] from the app toml, so that script derives the
// preprod config) and the gov-sync [env.preprod.vars] block. A value set on
// one side only is a live defect, not a config nit: TESSERA_BACKEND_URL on the
// app alone offers answers on surveys the site can no longer refresh, on
// gov-sync alone mirrors surveys nobody can see; a VAPID key mismatch sends
// pushes the subscription cannot verify; a PINATA_GOV_GROUP_ID mismatch makes
// the pin collector refuse every file it is meant to collect. Absent on both sides is a legitimate
// state (the surveys switch is deliberately off on mainnet), so the assertion
// is equality, with the always-present VAPID key proving the parsers actually
// match something.

const KEYS = ['CARDANO_NETWORK', 'VAPID_PUBLIC_KEY', 'TESSERA_BACKEND_URL', 'PINATA_GOV_GROUP_ID'] as const;

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

  // The preprod app config is derived by spreading the mainnet [vars], so a
  // network-bound value that nobody overrides silently carries mainnet's into
  // preprod. TESSERA_APP_URL is the one such var the lockstep check above
  // cannot see, gov-sync having no copy of it: a carried-over value would
  // deep-link preprod survey cards into the mainnet Tessera app, which looks
  // like a working link and answers on the wrong chain. "Different from
  // mainnet" alone would not catch it, since a deleted override also reads as
  // different (null): the override has to be present as well.
  it.each(['TESSERA_BACKEND_URL', 'TESSERA_APP_URL'] as const)(
    'preprod overrides the mainnet %s rather than inheriting it',
    key => {
      const mainnet = tomlVar('wrangler.toml', 'vars', key);
      const preprod = preprodAppVar(key);
      expect(mainnet).not.toBeNull();
      expect(preprod).not.toBeNull();
      expect(preprod).not.toBe(mainnet);
    },
  );
});

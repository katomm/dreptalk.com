import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Drift guard: the app worker and the gov-sync worker bundle the same src/lib
// code, so they must run under the same runtime compatibility date. The vitest
// workers pool derives its date from the app wrangler.toml, so keeping the two
// tomls equal keeps deploys and tests on one runtime behavior.

function compatDateOf(tomlPath: string): string {
  const toml = readFileSync(new URL(`../../${tomlPath}`, import.meta.url), 'utf8');
  const match = toml.match(/^compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"/m);
  if (!match) throw new Error(`compatibility_date not found in ${tomlPath}`);
  return match[1];
}

describe('compatibility date lockstep', () => {
  it('app and gov-sync workers declare the same compatibility date', () => {
    expect(compatDateOf('workers/gov-sync/wrangler.toml')).toBe(compatDateOf('wrangler.toml'));
  });
});

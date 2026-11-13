// Runs the inline restore script the way a browser would, against stubbed
// globals. The script is shared by the governance list and the Positions tab.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./sort-pref-restore.js', import.meta.url)), 'utf8');

const CONFIG = { key: 'k', sorts: 'recent,power', default: 'recent' };

function run(opts: {
  href: string;
  saved?: string;
  dataset?: Record<string, string>;
  brokenStorage?: boolean;
}) {
  const store = new Map<string, string>();
  if (opts.saved !== undefined) store.set('k', opts.saved);
  const replaced: string[] = [];
  const localStorage = opts.brokenStorage
    ? {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
      }
    : {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      };
  const document = { currentScript: { dataset: opts.dataset ?? CONFIG } };
  const location = { href: opts.href, replace: (u: string) => void replaced.push(u) };
  new Function('document', 'location', 'localStorage', source)(document, location, localStorage);
  return { saved: store.get('k'), replaced };
}

describe('sort-pref-restore', () => {
  it('stores a valid sort param and does not redirect', () => {
    const r = run({ href: 'https://x.test/t/a/?tab=positions&sort=power' });
    expect(r.saved).toBe('power');
    expect(r.replaced).toEqual([]);
  });

  it('stores the default when the reader picks it over a saved choice', () => {
    const r = run({ href: 'https://x.test/t/a/?tab=positions&sort=recent', saved: 'power' });
    expect(r.saved).toBe('recent');
    expect(r.replaced).toEqual([]);
  });

  it('does not store an unknown sort param', () => {
    const r = run({ href: 'https://x.test/t/a/?sort=foo', saved: 'power' });
    expect(r.saved).toBe('power');
    expect(r.replaced).toEqual([]);
  });

  it('matches sort values exactly, never as a substring of the list', () => {
    const r = run({ href: 'https://x.test/t/a/?tab=positions&sort=pow', saved: 'power' });
    expect(r.saved).toBe('power');
    expect(r.replaced).toEqual([]);
    // A saved fragment of a valid value is not a valid value either.
    expect(run({ href: 'https://x.test/t/a/?tab=positions', saved: 'pow' }).replaced).toEqual([]);
  });

  it('treats an empty sort param as present and invalid', () => {
    const r = run({ href: 'https://x.test/t/a/?tab=positions&sort=', saved: 'power' });
    expect(r.saved).toBe('power');
    expect(r.replaced).toEqual([]);
  });

  it('redirects once to a saved non-default sort and keeps the other params and the hash', () => {
    const r = run({ href: 'https://x.test/t/a/?tab=positions&voter=drep1abc#voter-drep1abc', saved: 'power' });
    expect(r.replaced).toEqual(['https://x.test/t/a/?tab=positions&voter=drep1abc&sort=power#voter-drep1abc']);
    // The redirected URL carries the param, so the next run only mirrors it.
    const next = run({ href: r.replaced[0], saved: 'power' });
    expect(next.replaced).toEqual([]);
  });

  it('does not redirect when the saved sort is the default', () => {
    expect(run({ href: 'https://x.test/t/a/?tab=positions', saved: 'recent' }).replaced).toEqual([]);
  });

  it('does not redirect when nothing is saved', () => {
    const r = run({ href: 'https://x.test/t/a/?tab=positions' });
    expect(r.replaced).toEqual([]);
    expect(r.saved).toBeUndefined();
  });

  it('ignores a saved value that is not in the list', () => {
    expect(run({ href: 'https://x.test/t/a/?tab=positions', saved: 'trending' }).replaced).toEqual([]);
  });

  it('survives a throwing localStorage', () => {
    expect(run({ href: 'https://x.test/t/a/?tab=positions', brokenStorage: true }).replaced).toEqual([]);
    expect(run({ href: 'https://x.test/t/a/?tab=positions&sort=power', brokenStorage: true }).replaced).toEqual([]);
  });

  it('does nothing without a config', () => {
    const r = run({ href: 'https://x.test/t/a/?sort=power', dataset: {} });
    expect(r.saved).toBeUndefined();
    expect(r.replaced).toEqual([]);
  });

  it('serves the governance list config', () => {
    const dataset = { key: 'k', sorts: 'new,old,trending,closing,ratified', default: 'new' };
    expect(run({ href: 'https://x.test/c/governance/', saved: 'closing', dataset }).replaced).toEqual([
      'https://x.test/c/governance/?sort=closing',
    ]);
    expect(run({ href: 'https://x.test/c/governance/', saved: 'new', dataset }).replaced).toEqual([]);
  });
});

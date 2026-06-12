import { describe, it, expect } from 'vitest';
import { slugBase, drepSlug, assignSlugs } from './slug.js';

describe('slugBase', () => {
  it('lowercases and collapses non-alphanumeric runs to single hyphens', () => {
    expect(slugBase('Lisa Cardano')).toBe('lisa-cardano');
    expect(slugBase('  A.B & C!  ')).toBe('a-b-c');
  });

  it('folds diacritics to ASCII', () => {
    expect(slugBase('Müller Ætt érto')).toBe('muller-tt-erto');
  });

  it('caps the base length without a trailing hyphen', () => {
    const base = slugBase(`${'a'.repeat(39)} bcdef`);
    expect(base.length).toBeLessThanOrEqual(40);
    expect(base.endsWith('-')).toBe(false);
  });

  it('returns empty for names with nothing slug-safe', () => {
    expect(slugBase('委任代表')).toBe('');
    expect(slugBase('***')).toBe('');
  });
});

describe('drepSlug', () => {
  const id = 'drep1y28nw6zz5yxmhnpx8pqzcnt6cyyqr2y3cgsuxfh257f0gcl9zulj';

  it('appends the id tail to the name base', () => {
    expect(drepSlug('Lisa Cardano', id)).toBe('lisa-cardano-9zulj');
  });

  it('returns null without a name or without a usable base', () => {
    expect(drepSlug(null, id)).toBeNull();
    expect(drepSlug('委任代表', id)).toBeNull();
  });
});

describe('assignSlugs', () => {
  const idA = 'drep1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaqqqqq';
  const idB = 'drep1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbwwwww';

  it('assigns unique slugs and skips nameless rows', () => {
    const taken = new Set<string>();
    const out = assignSlugs(
      [
        { drepId: idA, name: 'Lisa' },
        { drepId: idB, name: null },
      ],
      taken,
    );
    expect(out).toEqual([{ drepId: idA, slug: 'lisa-qqqqq' }]);
    expect(taken.has('lisa-qqqqq')).toBe(true);
  });

  it('lengthens the id tail when the short slug is taken', () => {
    const taken = new Set(['lisa-qqqqq']);
    const out = assignSlugs([{ drepId: idA, name: 'Lisa' }], taken);
    expect(out).toEqual([{ drepId: idA, slug: `lisa-${idA.slice(-10)}` }]);
  });

  it('skips a row when even the long slug is taken', () => {
    const taken = new Set(['lisa-qqqqq', `lisa-${idA.slice(-10)}`]);
    expect(assignSlugs([{ drepId: idA, name: 'Lisa' }], taken)).toEqual([]);
  });
});

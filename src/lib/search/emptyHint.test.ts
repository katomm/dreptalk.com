import { describe, it, expect } from 'vitest';
import { otherScopesWithCounts, otherScopesWithRows } from './emptyHint.js';

const counts = { forum: 3, governance: 5, dreps: 0, rationales: 0, reviews: 4, help: 2 };

describe('otherScopesWithCounts', () => {
  it('lists non-active scopes with hits, excluding the active one', () => {
    expect(otherScopesWithCounts(counts, 'dreps')).toEqual([
      { scope: 'governance', count: 5 },
      { scope: 'forum', count: 3 },
      { scope: 'reviews', count: 4 },
      { scope: 'help', count: 2 },
    ]);
  });

  it('excludes the active scope even if it has hits', () => {
    expect(otherScopesWithCounts({ ...counts, reviews: 0, help: 0 }, 'governance')).toEqual([{ scope: 'forum', count: 3 }]);
  });

  it('returns [] under all or without counts', () => {
    expect(otherScopesWithCounts(counts, 'all')).toEqual([]);
    expect(otherScopesWithCounts(null, 'dreps')).toEqual([]);
  });
});

describe('otherScopesWithRows', () => {
  const rows = [{ scope: null }, { scope: 'governance' as const }, { scope: 'dreps' as const }, { scope: 'reviews' as const }, { scope: 'help' as const }, { scope: 'all' as const }];
  it('returns non-active scopes that have rows, ignoring the exact match and pages, in display order', () => {
    expect(otherScopesWithRows(rows, 'dreps')).toEqual(['governance', 'reviews', 'help']);
  });
  it('returns [] under all', () => {
    expect(otherScopesWithRows(rows, 'all')).toEqual([]);
  });
});

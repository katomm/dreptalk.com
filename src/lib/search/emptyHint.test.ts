import { describe, it, expect } from 'vitest';
import { otherScopesWithCounts, otherScopesWithRows } from './emptyHint.js';

const counts = { forum: 3, governance: 5, dreps: 0, rationales: 0 };

describe('otherScopesWithCounts', () => {
  it('lists non-active scopes with hits, excluding the active one', () => {
    expect(otherScopesWithCounts(counts, 2, 'dreps')).toEqual([
      { scope: 'governance', count: 5 },
      { scope: 'forum', count: 3 },
      { scope: 'help', count: 2 },
    ]);
  });

  it('excludes the active scope even if it has hits', () => {
    expect(otherScopesWithCounts(counts, 0, 'governance')).toEqual([{ scope: 'forum', count: 3 }]);
  });

  it('returns [] under all or without counts', () => {
    expect(otherScopesWithCounts(counts, 1, 'all')).toEqual([]);
    expect(otherScopesWithCounts(null, 1, 'dreps')).toEqual([]);
  });
});

describe('otherScopesWithRows', () => {
  const rows = [
    { group: 'Exact match' },
    { group: 'Governance Actions' },
    { group: 'DReps' },
    { group: 'Help' },
  ];
  it('returns non-active scopes that have rows, ignoring Exact match, in display order', () => {
    expect(otherScopesWithRows(rows, 'dreps')).toEqual(['governance', 'help']);
  });
  it('returns [] under all', () => {
    expect(otherScopesWithRows(rows, 'all')).toEqual([]);
  });
});

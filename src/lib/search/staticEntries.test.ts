import { describe, it, expect } from 'vitest';
import { matchStaticEntries, STATIC_ENTRIES } from './staticEntries.js';

describe('matchStaticEntries', () => {
  it('returns all entries for an empty query (palette empty state)', () => {
    expect(matchStaticEntries('')).toEqual([...STATIC_ENTRIES]);
  });

  it('matches by label, case-insensitively', () => {
    const hits = matchStaticEntries('drep');
    expect(hits.some((e) => e.href === '/dreps')).toBe(true);
  });

  it('matches help articles by their text', () => {
    const hits = matchStaticEntries('flags');
    expect(hits.some((e) => e.href === '/help/moderation')).toBe(true);
  });

  it('returns nothing for a no-match query', () => {
    expect(matchStaticEntries('zzzzzz')).toEqual([]);
  });
});

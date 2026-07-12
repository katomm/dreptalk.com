import { describe, it, expect } from 'vitest';
import { matchStaticEntries, matchEntries, STATIC_ENTRIES } from './staticEntries.js';

describe('matchStaticEntries', () => {
  it('empty query returns all static (Pages) entries', () => {
    expect(matchStaticEntries('')).toEqual([...STATIC_ENTRIES]);
  });

  it('matches a page by keyword', () => {
    const hits = matchStaticEntries('directory');
    expect(hits.some((e) => e.href === '/dreps/')).toBe(true);
  });

  it('only contains Pages entries now', () => {
    expect(STATIC_ENTRIES.every((e) => e.group === 'Pages')).toBe(true);
  });

  it('no match returns empty', () => {
    expect(matchStaticEntries('zzzzzz')).toEqual([]);
  });
});

describe('matchEntries', () => {
  const help = [
    { label: 'Open source', href: '/help/open-source', keywords: 'apache license github' },
    { label: 'Badges', href: '/help/badges', keywords: 'achievement bronze silver gold' },
  ];

  it('empty query returns all', () => {
    expect(matchEntries(help, '')).toEqual([...help]);
  });

  it('matches by keyword', () => {
    expect(matchEntries(help, 'apache')).toHaveLength(1);
  });
});

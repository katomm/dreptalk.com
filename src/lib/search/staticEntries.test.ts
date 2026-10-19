import { describe, it, expect } from 'vitest';
import { matchStaticEntries, STATIC_ENTRIES, PERSONAL_ENTRIES } from './staticEntries.js';

describe('matchStaticEntries', () => {
  it('empty query returns all static (Pages) entries', () => {
    expect(matchStaticEntries('')).toEqual([...STATIC_ENTRIES]);
  });

  it('matches a page by keyword', () => {
    const hits = matchStaticEntries('directory');
    expect(hits.some((e) => e.href === '/dreps/')).toBe(true);
  });

  it('lists every page once', () => {
    const hrefs = STATIC_ENTRIES.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('finds the treasury overview by its Net Change Limit name', () => {
    expect(matchStaticEntries('net change limit').some((e) => e.href === '/treasury/')).toBe(true);
  });

  it('no match returns empty', () => {
    expect(matchStaticEntries('zzzzzz')).toEqual([]);
  });

  it('withholds the personal pages from a signed-out visitor', () => {
    const hrefs = matchStaticEntries('').map((e) => e.href);
    for (const e of PERSONAL_ENTRIES) expect(hrefs).not.toContain(e.href);
  });

  it('offers the personal pages once signed in', () => {
    const hrefs = matchStaticEntries('', true).map((e) => e.href);
    for (const e of PERSONAL_ENTRIES) expect(hrefs).toContain(e.href);
    expect(hrefs).toContain('/my-drep/');
  });

  it('every personal page is one that redirects a signed-out visitor to login', () => {
    // Guard against a public page drifting into the personal list, where it
    // would be hidden from exactly the visitors who can reach it.
    const publicHrefs = new Set(STATIC_ENTRIES.map((e) => e.href));
    for (const e of PERSONAL_ENTRIES) expect(publicHrefs.has(e.href)).toBe(false);
  });
});

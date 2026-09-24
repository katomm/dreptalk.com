import { describe, it, expect } from 'vitest';
import { parseScope, isScope, scopeForPath, searchPageHref, SCOPES } from './scopes.js';

describe('parseScope', () => {
  it('accepts every scope, content scopes included', () => {
    for (const s of SCOPES) expect(parseScope(s)).toBe(s);
    expect(parseScope('help')).toBe('help');
    expect(parseScope('reviews')).toBe('reviews');
  });
  it('maps junk to all', () => {
    expect(parseScope('nope')).toBe('all');
    expect(parseScope(null)).toBe('all');
  });
});

describe('isScope', () => {
  it('recognises the known scopes only', () => {
    expect(SCOPES.every(isScope)).toBe(true);
    expect(isScope('nope')).toBe(false);
    expect(isScope(null)).toBe(false);
  });
});

describe('scopeForPath', () => {
  it.each([
    ['/help/', 'help'],
    ['/help/becoming-a-drep/', 'help'],
    ['/glossary/', 'help'],
    ['/governance-review/', 'reviews'],
    ['/governance-review/epochs-653-655/', 'reviews'],
    ['/discussions/', 'forum'],
    ['/discussions', 'forum'],
    ['/dreps/', 'dreps'],
    ['/dreps', 'dreps'],
    ['/dreps/movers/', 'dreps'],
    ['/dreps/drep1abc/', 'all'], // DRep profile page stays on all
    ['/c/governance-actions/', 'governance'],
    ['/c/governance-actions', 'governance'],
    ['/c/budget/', 'governance'],
    ['/c/general/', 'forum'],
    ['/', 'all'],
    ['/settings/', 'all'],
  ])('maps %s to %s', (path, expected) => {
    expect(scopeForPath(path)).toBe(expected);
  });
});

describe('searchPageHref', () => {
  it('encodes the query and leaves out the defaults', () => {
    expect(searchPageHref('cc vote')).toBe('/search/?q=cc%20vote');
    expect(searchPageHref('a&b#c', 'help')).toBe('/search/?q=a%26b%23c&scope=help');
    expect(searchPageHref('x', 'dreps', 3)).toBe('/search/?q=x&scope=dreps&page=3');
    expect(searchPageHref('', 'all', 1)).toBe('/search/?q=');
  });
});

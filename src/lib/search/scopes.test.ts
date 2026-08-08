import { describe, it, expect } from 'vitest';
import { parseApiScope, isScope, groupToScope, scopeForPath, SCOPES } from './scopes.js';

describe('parseApiScope', () => {
  it('accepts D1 scopes', () => {
    expect(parseApiScope('forum')).toBe('forum');
    expect(parseApiScope('governance')).toBe('governance');
    expect(parseApiScope('dreps')).toBe('dreps');
    expect(parseApiScope('rationales')).toBe('rationales');
    expect(parseApiScope('all')).toBe('all');
  });
  it('maps help and junk to all', () => {
    expect(parseApiScope('help')).toBe('all');
    expect(parseApiScope('nope')).toBe('all');
    expect(parseApiScope(null)).toBe('all');
  });
});

describe('isScope', () => {
  it('recognises the five scopes only', () => {
    expect(SCOPES.every(isScope)).toBe(true);
    expect(isScope('nope')).toBe(false);
    expect(isScope(null)).toBe(false);
  });
});

describe('groupToScope', () => {
  it('maps palette groups', () => {
    expect(groupToScope('Governance Actions')).toBe('governance');
    expect(groupToScope('Discussions')).toBe('forum');
    expect(groupToScope('DReps')).toBe('dreps');
    expect(groupToScope('Rationales')).toBe('rationales');
    expect(groupToScope('Help')).toBe('help');
    expect(groupToScope('Pages')).toBe('all');
    expect(groupToScope('Exact match')).toBe('all');
  });
});

describe('scopeForPath', () => {
  it.each([
    ['/help/', 'help'],
    ['/help/becoming-a-drep/', 'help'],
    ['/glossary/', 'help'],
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

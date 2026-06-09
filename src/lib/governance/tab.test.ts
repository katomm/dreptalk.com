import { describe, it, expect } from 'vitest';
import { parseGaTab, GA_TABS } from './tab.js';

describe('parseGaTab', () => {
  it('defaults to overview for null/empty', () => {
    expect(parseGaTab(null)).toBe('overview');
    expect(parseGaTab(undefined)).toBe('overview');
    expect(parseGaTab('')).toBe('overview');
  });
  it('accepts known tabs', () => {
    expect(parseGaTab('overview')).toBe('overview');
    expect(parseGaTab('discussion')).toBe('discussion');
  });
  it('falls back to overview for unknown', () => {
    expect(parseGaTab('nope')).toBe('overview');
    expect(parseGaTab('positions')).toBe('overview'); // not shipped in PR1
  });
});

describe('GA_TABS', () => {
  it('lists the PR1 tabs in order', () => {
    expect(GA_TABS.map((t) => t.id)).toEqual(['overview', 'discussion']);
  });
});

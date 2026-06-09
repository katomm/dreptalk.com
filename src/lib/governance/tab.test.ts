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
    expect(parseGaTab('positions')).toBe('positions');
    expect(parseGaTab('onchain')).toBe('onchain');
    expect(parseGaTab('history')).toBe('history');
  });
  it('falls back to overview for unknown', () => {
    expect(parseGaTab('bogus')).toBe('overview');
    expect(parseGaTab('nope')).toBe('overview');
  });
});

describe('GA_TABS', () => {
  it('lists all tabs in order', () => {
    expect(GA_TABS.map((t) => t.id)).toEqual(['overview', 'discussion', 'positions', 'onchain', 'history']);
  });
});

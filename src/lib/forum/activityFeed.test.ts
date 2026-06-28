import { describe, it, expect } from 'vitest';
import { parseActivityFilter, ACTIVITY_TABS } from './activityFeed.js';

describe('parseActivityFilter', () => {
  it('defaults to comments and passes valid values through', () => {
    expect(parseActivityFilter(null)).toBe('comments');
    expect(parseActivityFilter('garbage')).toBe('comments');
    expect(parseActivityFilter('governance')).toBe('governance');
    expect(parseActivityFilter('comments')).toBe('comments');
    expect(parseActivityFilter('all')).toBe('all');
  });
});

describe('ACTIVITY_TABS', () => {
  it('is ordered all, governance, comments', () => {
    expect(ACTIVITY_TABS.map((t) => t.filter)).toEqual(['all', 'governance', 'comments']);
  });
});

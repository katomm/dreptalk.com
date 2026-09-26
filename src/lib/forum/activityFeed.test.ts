import { describe, it, expect } from 'vitest';
import { parseActivityFilter } from './activityFeed.js';

describe('parseActivityFilter', () => {
  it('defaults to all and passes valid values through', () => {
    expect(parseActivityFilter(null)).toBe('all');
    expect(parseActivityFilter('garbage')).toBe('all');
    expect(parseActivityFilter('governance')).toBe('governance');
    expect(parseActivityFilter('comments')).toBe('comments');
    expect(parseActivityFilter('all')).toBe('all');
  });
});

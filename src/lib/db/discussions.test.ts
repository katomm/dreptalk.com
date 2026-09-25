import { describe, it, expect } from 'vitest';
import { parseDiscussionSort } from './discussions.js';

describe('parseDiscussionSort', () => {
  it('keeps unanswered and defaults anything else to latest', () => {
    expect(parseDiscussionSort('unanswered')).toBe('unanswered');
    expect(parseDiscussionSort('bogus')).toBe('latest');
    expect(parseDiscussionSort(null)).toBe('latest');
  });
});

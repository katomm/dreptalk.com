import { describe, it, expect } from 'vitest';
import { median } from './median.js';

describe('median', () => {
  it('returns null for an empty list', () => {
    expect(median([])).toBeNull();
  });
  it('returns the single value for one element', () => {
    expect(median([4.5])).toBe(4.5);
  });
  it('returns the middle value for odd length', () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it('averages the two middle values for even length', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('sorts numerically, not lexicographically', () => {
    expect(median([10, 9, 2])).toBe(9);
  });
  it('handles unsorted fractional values', () => {
    expect(median([0.5, 12.25, 3.75])).toBe(3.75);
  });
});

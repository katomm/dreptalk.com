import { describe, it, expect } from 'vitest';
import { parseContentRangeTotal } from './contentRange.js';

describe('parseContentRangeTotal', () => {
  it('reads the total after the slash', () => {
    expect(parseContentRangeTotal('0-0/1659')).toBe(1659);
    expect(parseContentRangeTotal('0-24/1000')).toBe(1000);
    expect(parseContentRangeTotal('*/0')).toBe(0);
  });

  it('returns null when the total is unknown or the header is malformed', () => {
    expect(parseContentRangeTotal('*/*')).toBeNull();
    expect(parseContentRangeTotal('0-0/*')).toBeNull();
    expect(parseContentRangeTotal('garbage')).toBeNull();
    expect(parseContentRangeTotal('')).toBeNull();
    expect(parseContentRangeTotal(null)).toBeNull();
  });
});

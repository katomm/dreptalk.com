import { describe, expect, it } from 'vitest';
import { pct4 } from './pct.js';

describe('pct4', () => {
  it('keeps four decimals and stays exact past 2^53', () => {
    expect(pct4(1n, 3n)).toBe(33.3333);
    expect(pct4(9007199254740993n, 9007199254740993n * 4n)).toBe(25);
  });

  it('is 0 for an empty or negative whole', () => {
    expect(pct4(5n, 0n)).toBe(0);
    expect(pct4(5n, -1n)).toBe(0);
  });
});

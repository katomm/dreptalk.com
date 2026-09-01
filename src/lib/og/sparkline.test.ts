import { describe, expect, it } from 'vitest';
import { sparklinePaths } from './sparkline.js';

describe('sparklinePaths', () => {
  it('maps values onto a zero baseline with the maximum at the top pad', () => {
    const p = sparklinePaths([0, 50, 100], 200, 106, 6);
    expect(p?.line).toBe('M0,106 L100,56 L200,6');
    expect(p?.area).toBe('M0,106 L100,56 L200,6 L200,106 L0,106 Z');
    expect(p?.end).toEqual({ x: 200, y: 6 });
  });

  it('keeps a flat series flat instead of stretching it', () => {
    const p = sparklinePaths([40, 40, 40], 100, 56, 6);
    expect(p?.line).toBe('M0,6 L50,6 L100,6');
  });

  it('returns null for fewer than two points or no positive value', () => {
    expect(sparklinePaths([5], 100, 50)).toBeNull();
    expect(sparklinePaths([], 100, 50)).toBeNull();
    expect(sparklinePaths([0, 0], 100, 50)).toBeNull();
  });
});

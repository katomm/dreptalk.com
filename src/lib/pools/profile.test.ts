import { describe, expect, it } from 'vitest';
import { isCanonicalPoolParam, poolDisplayName, poolPath } from './profile.js';

const withSlug = { poolId: 'pool1abc', slug: 'hype-4x9k2' };
const noSlug = { poolId: 'pool1abc', slug: null };

describe('pool profile helpers', () => {
  it('prefers the slug for the path, falls back to the id', () => {
    expect(poolPath(withSlug)).toBe('/spos/hype-4x9k2');
    expect(poolPath(noSlug)).toBe('/spos/pool1abc');
  });

  it('recognises the canonical param', () => {
    expect(isCanonicalPoolParam(withSlug, 'hype-4x9k2')).toBe(true);
    expect(isCanonicalPoolParam(withSlug, 'pool1abc')).toBe(false);
    expect(isCanonicalPoolParam(noSlug, 'pool1abc')).toBe(true);
  });

  it('names a pool by name, then ticker, then truncated id', () => {
    expect(poolDisplayName({ name: 'HYPE Staking', ticker: 'HYPE', poolId: 'pool1abcdefghijklmnop' })).toBe('HYPE Staking');
    expect(poolDisplayName({ name: null, ticker: 'HYPE', poolId: 'pool1abcdefghijklmnop' })).toBe('HYPE');
    expect(poolDisplayName({ name: null, ticker: null, poolId: 'pool1abcdefghijklmnop' })).toContain('pool1');
  });
});

import { describe, expect, it } from 'vitest';
import { assignPoolSlugs, poolSlug } from './slug.js';

const idA = 'pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaqqqqq11111';
const idB = 'pool1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbqqqqq22222';

describe('pool slug', () => {
  it('builds a slug from the ticker plus an id tail', () => {
    expect(poolSlug('HYPE', idA)).toBe(`hype-${idA.slice(-5)}`);
  });

  it('returns null for an empty base', () => {
    expect(poolSlug('', idA)).toBeNull();
    expect(poolSlug(null, idA)).toBeNull();
  });

  it('disambiguates two pools that share a base via the id tail', () => {
    const out = assignPoolSlugs(
      [
        { poolId: idA, base: 'hype' },
        { poolId: idB, base: 'hype' },
      ],
      new Set(),
    );
    expect(out).toHaveLength(2);
    expect(out[0].slug).not.toBe(out[1].slug);
  });
});

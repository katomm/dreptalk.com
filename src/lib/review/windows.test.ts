import { describe, it, expect } from 'vitest';
import { slugFor, parseSlug, assertContiguous, buildEditionIndex } from './windows.js';

describe('slugs', () => {
  it('derives and parses the epochs slug', () => {
    expect(slugFor(650, 652)).toBe('epochs-650-652');
    expect(parseSlug('epochs-650-652')).toEqual({ from: 650, to: 652 });
    expect(parseSlug('epochs-652-650')).toBeNull();
    expect(parseSlug('something')).toBeNull();
  });
});

describe('assertContiguous', () => {
  it('accepts growth at both ends', () => {
    expect(() => assertContiguous([{ from: 650, to: 652 }, { from: 647, to: 649 }, { from: 653, to: 656 }])).not.toThrow();
  });
  it('rejects a gap and names it', () => {
    expect(() => assertContiguous([{ from: 650, to: 652 }, { from: 640, to: 645 }])).toThrow('gap between epochs-640-645 and epochs-650-652');
  });
  it('rejects an overlap', () => {
    expect(() => assertContiguous([{ from: 650, to: 652 }, { from: 652, to: 654 }])).toThrow('overlap');
  });
});

describe('buildEditionIndex', () => {
  const editions = [
    { from: 650, to: 652, featured: ['a#0'], rows: ['a#0', 'b#0'] },
    { from: 653, to: 655, featured: [], rows: ['a#0', 'c#0'] },
  ];
  it('prefers the edition that features the action, else the latest mention', () => {
    const idx = buildEditionIndex(editions);
    expect(idx.byActionId.get('a#0')).toBe('epochs-650-652');
    expect(idx.byActionId.get('c#0')).toBe('epochs-653-655');
    expect(idx.byActionId.get('b#0')).toBe('epochs-650-652');
    expect(idx.latest).toBe('epochs-653-655');
    expect(idx.lastCoveredEpoch).toBe(655);
  });
});

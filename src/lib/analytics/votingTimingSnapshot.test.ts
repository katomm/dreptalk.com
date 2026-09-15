import { describe, it, expect } from 'vitest';
import { reduceVotingTimingSnapshot, type ReduceVotingTimingInput } from './votingTimingSnapshot.js';
import { median } from './median.js';

const thirds = { early: 1, middle: 2, late: 3, afterClose: 4, basis: 6 };

function input(over: Partial<ReduceVotingTimingInput> = {}): ReduceVotingTimingInput {
  return { drepByType: [], spoByType: [], drepOverall: null, spoOverall: null, halfDays: [], thirds, ...over };
}

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

describe('reduceVotingTimingSnapshot', () => {
  it('reduces the raw half-turnout days to a median and a basis', () => {
    expect(reduceVotingTimingSnapshot(input({ halfDays: [4, 2, 6, 8] })).half).toEqual({ medianDay: 5, basis: 4 });
  });
  it('stores a null median and a zero basis for no half-turnout days', () => {
    expect(reduceVotingTimingSnapshot(input()).half).toEqual({ medianDay: null, basis: 0 });
  });
  it('passes overall, thirds and both by-type lists through unchanged', () => {
    const drepByType = [{ type: 'InfoAction', medianDay: 1, timedVotes: 30 }];
    const spoByType = [{ type: 'InfoAction', medianDay: 2, timedVotes: 25 }];
    const drepOverall = { medianDay: 3, timedVotes: 90 };
    const p = reduceVotingTimingSnapshot(input({ drepByType, spoByType, drepOverall }));
    expect(p.drepByType).toEqual(drepByType);
    expect(p.spoByType).toEqual(spoByType);
    expect(p.drepOverall).toEqual(drepOverall);
    expect(p.spoOverall).toBeNull();
    expect(p.thirds).toEqual(thirds);
  });
  it('keeps thin types in the payload, the view applies the threshold', () => {
    const drepByType = [
      { type: 'Thin', medianDay: 1, timedVotes: 19 },
      { type: 'Fat', medianDay: 2, timedVotes: 20 },
    ];
    expect(reduceVotingTimingSnapshot(input({ drepByType })).drepByType).toHaveLength(2);
  });
});

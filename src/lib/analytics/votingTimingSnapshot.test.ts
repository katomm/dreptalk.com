import { describe, it, expect } from 'vitest';
import { reduceVotingTimingSnapshot, type ReduceVotingTimingInput } from './votingTimingSnapshot.js';

const thirds = { early: 1, middle: 2, late: 3, afterClose: 4, basis: 6 };

function input(over: Partial<ReduceVotingTimingInput> = {}): ReduceVotingTimingInput {
  return { drepByType: [], spoByType: [], drepOverall: null, spoOverall: null, halfDays: [], thirds, ...over };
}

describe('reduceVotingTimingSnapshot', () => {
  it('reduces the raw half-turnout days to a median and a basis', () => {
    expect(reduceVotingTimingSnapshot(input({ halfDays: [4, 2, 6, 8] })).half).toEqual({ medianDay: 5, basis: 4 });
  });
  it('stores a null median and a zero basis for no half-turnout days', () => {
    expect(reduceVotingTimingSnapshot(input()).half).toEqual({ medianDay: null, basis: 0 });
  });
});

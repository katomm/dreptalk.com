import { describe, it, expect } from 'vitest';
import { buildVotingTiming, type BuildVotingTimingInput } from './votingTimingView.js';

const emptyThirds = { early: 0, middle: 0, late: 0, afterClose: 0, basis: 0 };

function input(over: Partial<BuildVotingTimingInput> = {}): BuildVotingTimingInput {
  return {
    drepByType: [],
    spoByType: [],
    drepOverall: null,
    spoOverall: null,
    half: { medianDay: null, basis: 0 },
    thirds: emptyThirds,
    ...over,
  };
}

describe('buildVotingTiming', () => {
  it('returns nulls, zeros, and an empty byType for empty input', () => {
    expect(buildVotingTiming(input())).toEqual({
      drepMedianDay: null,
      drepTimed: 0,
      spoMedianDay: null,
      spoTimed: 0,
      thirds: emptyThirds,
      halfTurnoutMedianDay: null,
      halfBasis: 0,
      byType: [],
    });
  });

  it('floors byType at 20 timed DRep votes, dropping thinner types entirely', () => {
    const v = buildVotingTiming(
      input({
        drepByType: [
          { type: 'ParameterChange', medianDay: 2, timedVotes: 25 },
          { type: 'InfoAction', medianDay: 4, timedVotes: 19 },
        ],
      }),
    );
    expect(v.byType).toEqual([
      { type: 'ParameterChange', drepMedianDay: 2, drepTimed: 25, spoMedianDay: null },
    ]);
  });

  it('joins the SPO median by type name, null when SPOs have no timed votes of that type', () => {
    const v = buildVotingTiming(
      input({
        drepByType: [
          { type: 'ParameterChange', medianDay: 2, timedVotes: 30 },
          { type: 'TreasuryWithdrawals', medianDay: 5, timedVotes: 22 },
        ],
        spoByType: [{ type: 'ParameterChange', medianDay: 7, timedVotes: 20 }],
      }),
    );
    expect(v.byType).toEqual([
      { type: 'ParameterChange', drepMedianDay: 2, drepTimed: 30, spoMedianDay: 7 },
      { type: 'TreasuryWithdrawals', drepMedianDay: 5, drepTimed: 22, spoMedianDay: null },
    ]);
  });

  it('floors the SPO median at 20 timed SPO votes, independent of the DRep count', () => {
    const v = buildVotingTiming(
      input({
        drepByType: [{ type: 'ParameterChange', medianDay: 2, timedVotes: 25 }],
        spoByType: [{ type: 'ParameterChange', medianDay: 7, timedVotes: 19 }],
      }),
    );
    expect(v.byType).toEqual([
      { type: 'ParameterChange', drepMedianDay: 2, drepTimed: 25, spoMedianDay: null },
    ]);

    const v2 = buildVotingTiming(
      input({
        drepByType: [{ type: 'ParameterChange', medianDay: 2, timedVotes: 25 }],
        spoByType: [{ type: 'ParameterChange', medianDay: 7, timedVotes: 20 }],
      }),
    );
    expect(v2.byType).toEqual([
      { type: 'ParameterChange', drepMedianDay: 2, drepTimed: 25, spoMedianDay: 7 },
    ]);
  });

  it('sorts byType by drepTimed descending, then type ascending on ties', () => {
    const v = buildVotingTiming(
      input({
        drepByType: [
          { type: 'C', medianDay: 1, timedVotes: 20 },
          { type: 'A', medianDay: 1, timedVotes: 20 },
          { type: 'B', medianDay: 1, timedVotes: 40 },
        ],
      }),
    );
    expect(v.byType.map((t) => t.type)).toEqual(['B', 'A', 'C']);
  });
});

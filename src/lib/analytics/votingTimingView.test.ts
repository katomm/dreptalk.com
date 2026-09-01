import { describe, it, expect } from 'vitest';
import { buildVotingTiming, type BuildVotingTimingInput } from './votingTimingView.js';

const emptyThirds = { early: 0, middle: 0, late: 0, afterClose: 0, basis: 0 };

function input(over: Partial<BuildVotingTimingInput> = {}): BuildVotingTimingInput {
  return {
    drepByType: [],
    spoByType: [],
    drepOverall: null,
    spoOverall: null,
    halfDays: [],
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

  it('passes the overall DRep and SPO medians through unchanged', () => {
    const v = buildVotingTiming(
      input({
        drepOverall: { medianDay: 3.5, timedVotes: 120 },
        spoOverall: { medianDay: 6.25, timedVotes: 40 },
      }),
    );
    expect(v.drepMedianDay).toBe(3.5);
    expect(v.drepTimed).toBe(120);
    expect(v.spoMedianDay).toBe(6.25);
    expect(v.spoTimed).toBe(40);
  });

  it('passes the window thirds and computes the half-turnout median from the raw days', () => {
    const thirds = { early: 10, middle: 20, late: 5, afterClose: 2, basis: 35 };
    const v = buildVotingTiming(input({ thirds, halfDays: [1, 3, 5] }));
    expect(v.thirds).toBe(thirds);
    expect(v.halfTurnoutMedianDay).toBe(3);
    expect(v.halfBasis).toBe(3);
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

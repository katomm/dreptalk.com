import { describe, it, expect } from 'vitest';
import { computeGini, computeEpochStatsRow, type EpochHistoryInput } from './epochStats.js';

function h(drepId: string, amount: string, delegatorCount: number | null = null): EpochHistoryInput {
  return { drepId, amount, delegatorCount };
}

const baseInput = {
  epoch: 540,
  recentlyVotingDrepIds: new Set(['drep1a', 'drep1gone', 'drep1z']),
  votesCast: 7,
  voteDataComplete: true,
  treasuryLovelace: '1234',
};

describe('computeGini', () => {
  it('is 0 for a perfectly equal distribution', () => {
    expect(computeGini([5n, 5n, 5n, 5n])).toBe(0);
  });

  it('matches the closed form for [1, 3]', () => {
    // G = (2 * (1*1 + 2*3)) / (2 * 4) - 3/2 = 0.25
    expect(computeGini([1n, 3n])).toBeCloseTo(0.25, 6);
  });

  it('ignores zero-power entries', () => {
    expect(computeGini([0n, 0n, 5n, 5n])).toBe(0);
  });

  it('is 0 for empty input', () => {
    expect(computeGini([])).toBe(0);
  });

  it('clamps the BigInt-truncation negative for three equal amounts to exactly 0', () => {
    expect(computeGini([5n, 5n, 5n])).toBe(0);
  });
});

describe('computeEpochStatsRow', () => {
  it('excludes specials from representative aggregates and maps them to their columns', () => {
    const row = computeEpochStatsRow({
      ...baseInput,
      history: [
        h('drep1big', '600', 100),
        h('drep1mid', '300', 50),
        h('drep1small', '100', 5),
        h('drep_always_abstain', '9000', 200),
        h('drep_always_no_confidence', '400', 10),
      ],
    });
    expect(row.totalDrepPower).toBe('1000');
    expect(row.poweredDrepCount).toBe(3);
    expect(row.abstainPower).toBe('9000');
    expect(row.ancPower).toBe('400');
    expect(row.abstainDelegators).toBe(200);
    expect(row.ancDelegators).toBe(10);
    expect(row.delegatorTotal).toBe(155);
    expect(row.minCoalition50).toBe(1); // 600 of 1000 is already 60%
    expect(row.minCoalition67).toBe(2); // 600 + 300 = 90%
    expect(row.top10SharePct).toBe(100);
    expect(row.votesCast).toBe(7);
    expect(row.voteDataComplete).toBe(true);
    expect(row.treasuryLovelace).toBe('1234');
  });

  it('partitions the snapshot into representative + abstain + anc exactly once', () => {
    const row = computeEpochStatsRow({
      ...baseInput,
      history: [
        h('drep1big', '600'),
        h('drep1mid', '400'),
        h('drep_always_abstain', '9000'),
        h('drep_always_no_confidence', '400'),
      ],
    });
    expect(
      BigInt(row.totalDrepPower) + BigInt(row.abstainPower ?? '0') + BigInt(row.ancPower ?? '0'),
    ).toBe(10400n);
  });

  it('never stores a partial delegator sum: one missing observation means NULL', () => {
    const row = computeEpochStatsRow({
      ...baseInput,
      history: [h('drep1big', '600', 100), h('drep1mid', '300', 50), h('drep1small', '100', null)],
    });
    expect(row.delegatorTotal).toBeNull();
  });

  it('leaves delegator columns NULL when nothing is stamped (backfill shape)', () => {
    const row = computeEpochStatsRow({
      ...baseInput,
      history: [h('drep1big', '600'), h('drep1mid', '300')],
    });
    expect(row.delegatorTotal).toBeNull();
    expect(row.abstainPower).toBeNull();
    expect(row.abstainDelegators).toBeNull();
  });

  it('counts only amount > 0 rows as powered', () => {
    const row = computeEpochStatsRow({
      ...baseInput,
      history: [h('drep1big', '600'), h('drep1zero', '0')],
    });
    expect(row.poweredDrepCount).toBe(1);
    expect(row.totalDrepPower).toBe('600');
  });

  it('computes the top-10 share from the raw distribution', () => {
    // 11 DReps of 100 each: top 10 hold 1000 of 1100, exactly 90.909090...%.
    const row = computeEpochStatsRow({
      ...baseInput,
      history: Array.from({ length: 11 }, (_, i) => h(`drep1n${i}`, '100')),
    });
    expect(row.top10SharePct).toBeCloseTo(90.9090, 3);
  });

  it('throws on duplicate snapshot rows for one DRep', () => {
    expect(() =>
      computeEpochStatsRow({ ...baseInput, history: [h('drep1a', '1'), h('drep1a', '2')] }),
    ).toThrow(/duplicate/i);
  });
});

describe('silent powered DReps', () => {
  it('counts power holders outside the recently-voting set, a voter without power is never silent', () => {
    const row = computeEpochStatsRow({
      ...baseInput,
      history: [h('drep1a', '600'), h('drep1b', '400'), h('drep1zero', '0'), h('drep_always_abstain', '9000')],
    });
    // drep1a voted, drep1b did not, drep1zero holds nothing, the special is excluded.
    expect(row.silentPoweredDrepCount).toBe(1);
    // The recently-voting count is the set size, voters without power included.
    expect(row.recentlyVotingDrepCount).toBe(3);
  });
});

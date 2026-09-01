// Pure-logic tests for seriesStartFromRows, the in-memory equivalent of
// seriesStartEpoch. Cases mirror epochStatsContract.workers.test.ts so the
// two implementations stay behaviorally identical.
import { describe, it, expect } from 'vitest';
import { EPOCH_STATS_METRICS, seriesStartFromRows } from './epochStatsContract.js';
import type { EpochStatsRow } from './epochStats.js';

function row(epoch: number, over: Partial<EpochStatsRow> = {}): EpochStatsRow {
  return {
    epoch,
    totalDrepPower: '1000',
    poweredDrepCount: 10,
    recentlyVotingDrepCount: 5,
    abstainPower: '500',
    ancPower: '50',
    delegatorTotal: null,
    abstainDelegators: null,
    ancDelegators: null,
    gini: 0.5,
    top10SharePct: 40,
    minCoalition50: 3,
    minCoalition67: 5,
    votesCast: 12,
    voteDataComplete: true,
    treasuryLovelace: '99',
    ...over,
  };
}

describe('seriesStartFromRows', () => {
  it('returns null with no rows', () => {
    expect(seriesStartFromRows([], 'totalDrepPower')).toBeNull();
  });

  it('starts oldest-row metrics at the first row epoch (rows already epoch ascending)', () => {
    const rows = [row(510), row(511)];
    expect(seriesStartFromRows(rows, 'totalDrepPower')).toBe(510);
    expect(seriesStartFromRows(rows, 'gini')).toBe(510);
  });

  it('starts first-non-null metrics at their first non-null row, exact ones included', () => {
    const rows = [
      row(510, { delegatorTotal: null, treasuryLovelace: null }),
      row(511, { delegatorTotal: 90000, treasuryLovelace: null }),
      row(512, { delegatorTotal: 91000, treasuryLovelace: '77' }),
    ];
    expect(seriesStartFromRows(rows, 'delegatorTotal')).toBe(511);
    expect(seriesStartFromRows(rows, 'treasuryLovelace')).toBe(512);
  });

  it('starts first-complete metrics at the first row with voteDataComplete true', () => {
    const rows = [row(510, { voteDataComplete: false }), row(511, { voteDataComplete: true })];
    expect(seriesStartFromRows(rows, 'votesCast')).toBe(511);
    expect(seriesStartFromRows(rows, 'recentlyVotingDrepCount')).toBe(511);
  });

  it('every metric key is a real EpochStatsRow field, so the in-memory lookup needs no name map', () => {
    const r = row(540);
    for (const key of Object.keys(EPOCH_STATS_METRICS) as (keyof typeof EPOCH_STATS_METRICS)[]) {
      expect(Object.hasOwn(r, key)).toBe(true);
    }
  });
});

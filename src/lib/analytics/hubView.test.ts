import { describe, it, expect } from 'vitest';
import { buildGlanceTiles, buildVitals, commonSeriesStart, contiguousPrefix, contiguousTail, defaultOptionsComparison, metricSeries, netChange, rowBeforeEpoch, defaultsShareSeries, votedShareSeries } from './hubView.js';
import { RECENT_VOTING_WINDOW_EPOCHS, seriesStartFromRows } from './epochStatsContract.js';
import { hubHref } from './hubSections.js';
import type { EpochStatsRow } from './epochStats.js';

function row(epoch: number, over: Partial<EpochStatsRow> = {}): EpochStatsRow {
  return {
    epoch,
    totalDrepPower: '2000000000000000',
    poweredDrepCount: 700,
    recentlyVotingDrepCount: 300,
    silentPoweredDrepCount: 200,
    abstainPower: '9000',
    ancPower: '400',
    delegatorTotal: null,
    abstainDelegators: null,
    ancDelegators: null,
    gini: 0.9,
    top10SharePct: 50,
    minCoalition50: 10,
    minCoalition67: 20,
    votesCast: 40,
    voteDataComplete: false,
    treasuryLovelace: '1',
    ...over,
  };
}

describe('netChange', () => {
  it('formats a signed delta with direction', () => {
    const chip = netChange(102000, 100000, (n) => n.toLocaleString('en-US'));
    expect(chip).toEqual({ label: '+2,000 this epoch', direction: 'up' });
  });
  it('is flat at zero and null without both points', () => {
    expect(netChange(5, 5, String)?.direction).toBe('flat');
    expect(netChange(5, null, String)).toBeNull();
    expect(netChange(null, 5, String)).toBeNull();
  });
});

describe('metricSeries', () => {
  it('clips to the series start and skips null values', () => {
    const rows = [
      row(538, { delegatorTotal: null }),
      row(539, { delegatorTotal: 90000 }),
      row(540, { delegatorTotal: 91000 }),
    ];
    expect(metricSeries(rows, 'delegatorTotal', 539)).toEqual([
      { epoch: 539, value: 90000 },
      { epoch: 540, value: 91000 },
    ]);
  });
  it('reads lovelace strings as chart numbers', () => {
    const pts = metricSeries([row(540)], 'totalDrepPower', 540);
    expect(pts[0].value).toBe(2000000000000000);
  });
  it('returns empty when the start is unknown', () => {
    expect(metricSeries([row(540)], 'delegatorTotal', null)).toEqual([]);
  });
  it('does not clip a trailing incomplete row for recentlyVotingDrepCount: seriesStartFromRows only decides the start, so the page must still clip the tail itself', () => {
    const rows = [
      row(538, { voteDataComplete: true, recentlyVotingDrepCount: 100 }),
      row(539, { voteDataComplete: true, recentlyVotingDrepCount: 110 }),
      row(540, { voteDataComplete: false, recentlyVotingDrepCount: 120 }),
    ];
    const start = seriesStartFromRows(rows, 'recentlyVotingDrepCount');
    expect(start).toBe(538); // the first complete row, not the last
    expect(metricSeries(rows, 'recentlyVotingDrepCount', start)).toEqual([
      { epoch: 538, value: 100 },
      { epoch: 539, value: 110 },
      { epoch: 540, value: 120 }, // still included despite voteDataComplete: false
    ]);
  });
});

describe('buildVitals', () => {
  it('builds four cards with deltas and the circulating share', () => {
    const cards = buildVitals(row(540, { poweredDrepCount: 710 }), row(539), '20000000000000000');
    expect(cards).toHaveLength(4);
    expect(cards[0].label).toBe('DReps holding delegated power');
    expect(cards[0].trend?.direction).toBe('up'); // powered 700 -> 710
    const share = cards.find((c) => c.icon === 'share');
    expect(share?.value).toBe('10.0%'); // 2e15 of 2e16
  });
  it('omits the share value when circulation is unknown', () => {
    const cards = buildVitals(row(540), row(539), null);
    const share = cards.find((c) => c.icon === 'share');
    expect(share?.value).toBe('n/a');
  });
  it('returns empty without a current row', () => {
    expect(buildVitals(null, null, '1')).toEqual([]);
  });
  it('formats the delegated-power trend as ada, not a raw lovelace count', () => {
    const cards = buildVitals(
      row(540, { totalDrepPower: '3000000000000' }),
      row(539, { totalDrepPower: '1000000000000' }),
      null,
    );
    const power = cards.find((c) => c.icon === 'power');
    // Delta is 2,000,000,000,000 lovelace, formatAda renders that as whole ada
    // with the currency symbol, never as an unreadable raw lovelace digit run.
    expect(power?.trend).toEqual({ direction: 'up', label: '+2,000,000 ₳ this epoch' });
  });
  it('interpolates the recent-voting window into the label instead of hard-coding it', () => {
    const cards = buildVitals(row(540), row(539), null);
    const gauge = cards.find((c) => c.icon === 'gauge');
    expect(gauge?.label).toBe(`Voted in the last ${RECENT_VOTING_WINDOW_EPOCHS} epochs`);
  });
  it('marks the voting card provisional while the running epoch is incomplete', () => {
    const cards = buildVitals(row(540, { voteDataComplete: false }), row(539), null);
    const gauge = cards.find((c) => c.icon === 'gauge');
    expect(gauge?.sub).toBe('still filling in for the running epoch');
  });
  it('shows the definition tail on the voting card once the epoch is complete', () => {
    const cards = buildVitals(row(540, { voteDataComplete: true }), row(539), null);
    const gauge = cards.find((c) => c.icon === 'gauge');
    expect(gauge?.sub).toBe('superseded votes included');
  });
  it('never renders NaN% when totalDrepPower is malformed', () => {
    const cards = buildVitals(
      row(540, { totalDrepPower: 'not-a-number' }),
      row(539),
      '20000000000000000',
    );
    const share = cards.find((c) => c.icon === 'share');
    expect(share?.value).toBe('n/a');
  });
  it('never renders NaN% when circulation is malformed', () => {
    const cards = buildVitals(row(540), row(539), 'not-a-number');
    const share = cards.find((c) => c.icon === 'share');
    expect(share?.value).toBe('n/a');
  });
});

describe('contiguousPrefix', () => {
  it('returns the input unchanged when the epochs are gapless', () => {
    const rows = [row(600), row(601), row(602)];
    expect(contiguousPrefix(rows)).toBe(rows);
  });

  it('clips at the first hole so charts never draw across missing epochs', () => {
    const rows = [row(508), row(509), row(510), row(652)];
    expect(contiguousPrefix(rows).map((r) => r.epoch)).toEqual([508, 509, 510]);
  });

  it('handles empty and single-row inputs', () => {
    expect(contiguousPrefix([])).toEqual([]);
    expect(contiguousPrefix([row(650)]).map((r) => r.epoch)).toEqual([650]);
  });
});

describe('rowBeforeEpoch', () => {
  it('finds exactly the previous epoch, never a positional neighbor', () => {
    const rows = [row(508), row(509), row(652)];
    expect(rowBeforeEpoch(rows, 652)).toBeNull();
    expect(rowBeforeEpoch(rows, 510)?.epoch).toBe(509);
  });

  it('returns the true previous row on a contiguous series', () => {
    const rows = [row(650), row(651), row(652)];
    expect(rowBeforeEpoch(rows, 652)?.epoch).toBe(651);
  });
});

describe('defaultOptionsComparison', () => {
  it('sums the two default pools and formats both labels compact', () => {
    const v = defaultOptionsComparison('9776000000000000', '150000000000000', '5134000000000000');
    expect(v?.defaultsLabel).toMatch(/^9\.9B/);
    expect(v?.reprLabel).toMatch(/^5\.1B/);
  });

  it('is null when any input is null or undefined', () => {
    expect(defaultOptionsComparison(null, '150000000000000', '5134000000000000')).toBeNull();
    expect(defaultOptionsComparison('9776000000000000', undefined, '5134000000000000')).toBeNull();
    expect(defaultOptionsComparison('9776000000000000', '150000000000000', null)).toBeNull();
  });

  it('is null when any amount is malformed', () => {
    expect(defaultOptionsComparison('not-a-number', '150000000000000', '5134000000000000')).toBeNull();
    expect(defaultOptionsComparison('9776000000000000', 'not-a-number', '5134000000000000')).toBeNull();
    expect(defaultOptionsComparison('9776000000000000', '150000000000000', 'not-a-number')).toBeNull();
  });
});

describe('contiguousTail', () => {
  it('keeps only the gapless run ending at the newest row', () => {
    expect(contiguousTail([row(100), row(101), row(538), row(539), row(540)]).map((r) => r.epoch)).toEqual([538, 539, 540]);
    expect(contiguousTail([row(540)]).map((r) => r.epoch)).toEqual([540]);
    expect(contiguousTail([])).toEqual([]);
  });
});

describe('buildGlanceTiles', () => {
  const window = [538, 539, 540].map((e) => row(e, { poweredDrepCount: 700 + (e - 538) * 5, voteDataComplete: e < 540 }));
  it('builds four linked tiles that each jump into a hub section', () => {
    const tiles = buildGlanceTiles(window, '20000000000000000');
    expect(tiles).toHaveLength(4);
    expect(tiles.map((t) => t.href)).toEqual([hubHref('trends'), hubHref('today'), hubHref('activity'), hubHref('decentralization')]);
    expect(tiles[0].trend?.direction).toBe('up'); // powered 705 -> 710
    expect(tiles[1].value).toBe('2B ₳');
    expect(tiles[1].sub).toBe('10.0% of circulating ada'); // 2e15 of 2e16
    expect(tiles[3].value).toBe('50.0%');
    expect(tiles[3].ring).toBe(50);
  });
  it('carries each metric series over the window, the voter series without the provisional epoch', () => {
    const tiles = buildGlanceTiles(window, null);
    expect(tiles[0].series).toEqual([700, 705, 710]);
    expect(tiles[2].series).toHaveLength(2); // epoch 540 is still running
    expect(tiles[3].series).toEqual([50, 50, 50]);
  });
  it('pairs the trend with the true previous epoch and draws only the gapless tail', () => {
    const tiles = buildGlanceTiles([row(100, { poweredDrepCount: 1 }), row(540, { poweredDrepCount: 710 })], null);
    expect(tiles[0].trend).toBeNull(); // 100 is not the epoch before 540
    expect(tiles[0].series).toEqual([710]);
  });
  it('formats the power trend compactly so it fits a narrow tile', () => {
    const tiles = buildGlanceTiles([row(539, { totalDrepPower: '2000000000000000' }), row(540, { totalDrepPower: '2030000000000000' })], null);
    expect(tiles[1].trend?.label).toBe('+30M ₳ this epoch');
  });
  it('drops the circulating share when circulation is unknown', () => {
    expect(buildGlanceTiles([row(540)], null)[1].sub).toBeUndefined();
  });
  it('flags the recent-voter count as provisional while the epoch is running', () => {
    expect(buildGlanceTiles([row(540, { voteDataComplete: false })], null)[2].sub).toMatch(/running epoch/);
    expect(buildGlanceTiles([row(540, { voteDataComplete: true })], null)[2].sub).toBeUndefined();
  });
  it('returns empty without rows', () => {
    expect(buildGlanceTiles([], '1')).toEqual([]);
  });
});

describe('commonSeriesStart', () => {
  it('picks the start most charts share', () => {
    expect(commonSeriesStart([508, 508, 508, 631, null])).toBe(508);
  });

  it('is null when no start repeats, so every chart keeps its own caption', () => {
    expect(commonSeriesStart([508, 631, null])).toBeNull();
    expect(commonSeriesStart([])).toBeNull();
    expect(commonSeriesStart([null, null])).toBeNull();
  });

  it('resolves a tie to the earlier epoch', () => {
    expect(commonSeriesStart([631, 631, 508, 508])).toBe(508);
  });
});

describe('defaultsShareSeries', () => {
  it('reads the default options as a share of all delegated power and skips rows missing an option', () => {
    const rows = [
      row(538, { totalDrepPower: '3000', abstainPower: '1000', ancPower: null }),
      row(539, { totalDrepPower: '3000', abstainPower: '900', ancPower: '100' }),
      row(540, { totalDrepPower: '1000', abstainPower: '2500', ancPower: '500' }),
    ];
    expect(defaultsShareSeries(rows)).toEqual([
      { epoch: 539, value: 25 },
      { epoch: 540, value: 75 },
    ]);
  });

  it('skips a malformed stored amount instead of throwing', () => {
    expect(defaultsShareSeries([row(538, { abstainPower: 'x', ancPower: '1' })])).toEqual([]);
  });
});

describe('votedShareSeries', () => {
  it('reads voted powered DReps against the same snapshot and skips rows without a silent count', () => {
    const rows = [
      row(538, { poweredDrepCount: 400, silentPoweredDrepCount: null }),
      row(539, { poweredDrepCount: 400, silentPoweredDrepCount: 300 }),
      row(540, { poweredDrepCount: 0, silentPoweredDrepCount: 0 }),
    ];
    expect(votedShareSeries(rows)).toEqual([{ epoch: 539, value: 25 }]);
  });
});

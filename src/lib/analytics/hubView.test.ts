import { describe, it, expect } from 'vitest';
import { buildVitals, contiguousPrefix, metricSeries, netChange, rowBeforeEpoch } from './hubView.js';
import { RECENT_VOTING_WINDOW_EPOCHS } from './epochStatsContract.js';
import type { EpochStatsRow } from './epochStats.js';

function row(epoch: number, over: Partial<EpochStatsRow> = {}): EpochStatsRow {
  return {
    epoch,
    totalDrepPower: '2000000000000000',
    poweredDrepCount: 700,
    recentlyVotingDrepCount: 300,
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
});

describe('buildVitals', () => {
  it('builds four cards with deltas and the circulating share', () => {
    const cards = buildVitals(row(540, { poweredDrepCount: 710 }), row(539), '20000000000000000');
    expect(cards).toHaveLength(4);
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

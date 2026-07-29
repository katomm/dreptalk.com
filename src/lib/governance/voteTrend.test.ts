import { describe, it, expect } from 'vitest';
import { buildTrendChart, type TrendSeries, computeVoteTrendSeries, type TrendBodyInput } from './voteTrend.js';

const series = (over: Partial<TrendSeries> = {}): TrendSeries => ({
  key: 'DRep',
  points: [
    { t: 0, pct: 0 },
    { t: 50, pct: 40 },
    { t: 100, pct: 80 },
  ],
  thresholdPct: 67,
  finalLabel: '80%',
  ...over,
});

describe('buildTrendChart', () => {
  it('returns null for an empty series list', () => {
    expect(buildTrendChart([])).toBeNull();
  });

  it('maps a fixed 0..100 y axis with 0 at the bottom and 100 at the top', () => {
    const c = buildTrendChart([series()], {
      width: 200, height: 100, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
    })!;
    const y0 = c.yTicks.find((t) => t.value === 0)!.y;
    const y100 = c.yTicks.find((t) => t.value === 100)!.y;
    expect(y0).toBeCloseTo(100); // 0% at the bottom edge
    expect(y100).toBeCloseTo(0); // 100% at the top edge
  });

  it('emits a step-after path (H before V) rising to the final pct', () => {
    const c = buildTrendChart([series()], {
      width: 200, height: 100, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, domain: [0, 100],
    })!;
    const p = c.series[0].stepPath;
    expect(p.startsWith('M 0,100')).toBe(true); // starts bottom-left (t=0, 0%)
    // step-after: a horizontal move precedes each vertical jump.
    expect(p.indexOf('H') < p.indexOf('V')).toBe(true);
    // final point sits at x = full width, y = 20 (80% of 100px, inverted).
    expect(c.series[0].last.x).toBeCloseTo(200);
    expect(c.series[0].last.y).toBeCloseTo(20);
  });

  it('places the threshold line on the same inverted scale', () => {
    const c = buildTrendChart([series({ thresholdPct: 50 })], {
      width: 200, height: 100, padTop: 0, padBottom: 0,
    })!;
    expect(c.series[0].thresholdY).toBeCloseTo(50); // 50% -> middle
  });

  it('renders a single-vote series (0 -> jump -> final) as a valid two-plus-point path', () => {
    const one = series({ points: [{ t: 0, pct: 0 }, { t: 30, pct: 60 }, { t: 100, pct: 60 }], finalLabel: '60%' });
    const c = buildTrendChart([one], { width: 200, height: 100, domain: [0, 100] })!;
    expect(c.series[0].stepPath).toContain('V'); // has the jump
    expect(c.series[0].finalLabel).toBe('60%');
  });

  it('shares one time domain across multiple bodies', () => {
    const c = buildTrendChart(
      [series({ key: 'DRep' }), series({ key: 'CC', points: [{ t: 0, pct: 0 }, { t: 20, pct: 71 }, { t: 100, pct: 71 }], finalLabel: '5 of 7' })],
      { width: 200, height: 100, padLeft: 0, padRight: 0, domain: [0, 100] },
    )!;
    expect(c.series).toHaveLength(2);
    // both series map t=100 to the same right edge x.
    expect(c.series[0].last.x).toBeCloseTo(c.series[1].last.x);
  });
});

describe('computeVoteTrendSeries', () => {
  const window = { start: 1000, end: 2000 };

  it('normalizes cumulative yes-weight to the exact final pct at the window end', () => {
    const body: TrendBodyInput = {
      key: 'DRep',
      yesVotes: [
        { blockTime: 1200, weight: 30 },
        { blockTime: 1600, weight: 70 },
      ],
      finalPct: 55,
      thresholdPct: 67,
      finalLabel: '55%',
    };
    const [s] = computeVoteTrendSeries([body], window);
    expect(s.points[0]).toEqual({ t: 1000, pct: 0 });
    // after first vote: 55 * 30/100 = 16.5
    expect(s.points[1]).toEqual({ t: 1200, pct: 16.5 });
    // after second vote: 55 * 100/100 = 55
    expect(s.points[2]).toEqual({ t: 1600, pct: 55 });
    // held flat to the window end at the exact final pct
    expect(s.points[s.points.length - 1]).toEqual({ t: 2000, pct: 55 });
  });

  it('orders votes by block time regardless of input order', () => {
    const body: TrendBodyInput = {
      key: 'SPO',
      yesVotes: [
        { blockTime: 1600, weight: 70 },
        { blockTime: 1200, weight: 30 },
      ],
      finalPct: 100,
      thresholdPct: 51,
      finalLabel: '100%',
    };
    const [s] = computeVoteTrendSeries([body], window);
    expect(s.points.map((p) => p.t)).toEqual([1000, 1200, 1600, 2000]);
    expect(s.points[1].pct).toBeCloseTo(30);
  });

  it('keeps a single yes vote as a valid curve', () => {
    const body: TrendBodyInput = {
      key: 'CC', yesVotes: [{ blockTime: 1500, weight: 1 }], finalPct: 71.43, thresholdPct: 66.67, finalLabel: '5 of 7',
    };
    const [s] = computeVoteTrendSeries([body], window);
    expect(s.points).toEqual([
      { t: 1000, pct: 0 },
      { t: 1500, pct: 71.43 },
      { t: 2000, pct: 71.43 },
    ]);
  });

  it('drops a body with no yes votes or null final pct', () => {
    expect(computeVoteTrendSeries([
      { key: 'DRep', yesVotes: [], finalPct: 40, thresholdPct: 67, finalLabel: '40%' },
      { key: 'SPO', yesVotes: [{ blockTime: 1200, weight: 5 }], finalPct: null, thresholdPct: 51, finalLabel: '' },
    ], window)).toEqual([]);
  });
});

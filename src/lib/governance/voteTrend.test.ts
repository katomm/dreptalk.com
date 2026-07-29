import { describe, it, expect } from 'vitest';
import { buildTrendChart, type TrendSeries } from './voteTrend.js';

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

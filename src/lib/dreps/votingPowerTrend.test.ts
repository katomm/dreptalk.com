import { describe, it, expect } from 'vitest';
import {
  computeVotingPowerDelta,
  formatTrendPct,
  formatTrendDelta,
  pctIsMeaningful,
  PCT_DISPLAY_CAP,
  absLovelace,
  buildPowerChart,
  buildOverlaySeries,
} from './votingPowerTrend.js';

describe('computeVotingPowerDelta', () => {
  it('reports a gain with positive percent and signed lovelace', () => {
    const d = computeVotingPowerDelta('1100', '1000');
    expect(d).toEqual({ direction: 'up', pct: 10, deltaLovelace: '100' });
  });

  it('reports a loss with negative percent and signed lovelace', () => {
    const d = computeVotingPowerDelta('900', '1000');
    expect(d).toEqual({ direction: 'down', pct: -10, deltaLovelace: '-100' });
  });

  it('reports flat when unchanged', () => {
    const d = computeVotingPowerDelta('1000', '1000');
    expect(d).toEqual({ direction: 'flat', pct: 0, deltaLovelace: '0' });
  });

  it('returns null when there is no previous snapshot', () => {
    expect(computeVotingPowerDelta('1000', null)).toBeNull();
  });

  it('returns null when there is no current snapshot', () => {
    expect(computeVotingPowerDelta(null, '1000')).toBeNull();
  });

  it('returns null for non-numeric input', () => {
    expect(computeVotingPowerDelta('abc', '1000')).toBeNull();
    expect(computeVotingPowerDelta('1000', '')).toBeNull();
  });

  it('omits percent (null) when the previous snapshot was zero', () => {
    const d = computeVotingPowerDelta('500', '0');
    expect(d).toEqual({ direction: 'up', pct: null, deltaLovelace: '500' });
  });

  it('handles values beyond Number precision without losing lovelace digits', () => {
    const d = computeVotingPowerDelta('9000000000000001', '9000000000000000');
    expect(d?.deltaLovelace).toBe('1');
    expect(d?.direction).toBe('up');
  });
});

describe('formatTrendPct', () => {
  it('formats with one decimal and no sign (sign is conveyed by arrow/color)', () => {
    expect(formatTrendPct(3.42)).toBe('3.4%');
    expect(formatTrendPct(-1.16)).toBe('1.2%');
  });

  it('renders an exact zero as 0%', () => {
    expect(formatTrendPct(0)).toBe('0%');
  });

  it('renders a tiny nonzero change as <0.1%', () => {
    expect(formatTrendPct(0.03)).toBe('<0.1%');
    expect(formatTrendPct(-0.04)).toBe('<0.1%');
  });
});

describe('formatTrendDelta', () => {
  const delta = (snapshot: string, prev: string) => computeVotingPowerDelta(snapshot, prev);

  it('offers both labels for an ordinary move', () => {
    expect(formatTrendDelta(delta('1100000000', '1000000000'))).toEqual({ pct: '10.0%', ada: '100 ₳' });
    expect(formatTrendDelta(delta('900000000', '1000000000'))).toEqual({ pct: '10.0%', ada: '100 ₳' });
    expect(formatTrendDelta(delta('1000000000', '1000000000'))).toEqual({ pct: '0%', ada: '0 ₳' });
  });

  it('keeps the percent just below the cap', () => {
    const d = { direction: 'up' as const, pct: PCT_DISPLAY_CAP - 0.1, deltaLovelace: '999900000000' };
    expect(formatTrendDelta(d)).toEqual({ pct: '999.9%', ada: '999.9K ₳' });
  });

  it('drops the percent at and beyond the cap', () => {
    const d = { direction: 'up' as const, pct: PCT_DISPLAY_CAP, deltaLovelace: '1000000000000' };
    expect(formatTrendDelta(d)).toEqual({ pct: null, ada: '1M ₳' });
  });

  it('drops the percent for a near-zero baseline', () => {
    // 6.3 ₳ grows to 805.9K ₳: the percent is true and useless.
    expect(formatTrendDelta(delta('805900000000', '6300000'))).toEqual({ pct: null, ada: '805.9K ₳' });
  });

  it('drops the percent when there is none to begin with', () => {
    expect(formatTrendDelta(delta('500000000', '0'))).toEqual({ pct: null, ada: '500 ₳' });
  });

  it('returns null when nothing moved and no percent exists', () => {
    expect(formatTrendDelta(delta('0', '0'))).toBeNull();
  });

  it('passes a missing delta straight through, so callers need no null guard', () => {
    expect(formatTrendDelta(null)).toBeNull();
    expect(formatTrendDelta(delta('1000', null as unknown as string))).toBeNull();
  });
});

describe('pctIsMeaningful', () => {
  it('accepts percents below the cap and rejects the rest', () => {
    expect(pctIsMeaningful(0)).toBe(true);
    expect(pctIsMeaningful(-99.9)).toBe(true);
    expect(pctIsMeaningful(PCT_DISPLAY_CAP - 0.1)).toBe(true);
    expect(pctIsMeaningful(PCT_DISPLAY_CAP)).toBe(false);
    expect(pctIsMeaningful(12363734.7)).toBe(false);
    expect(pctIsMeaningful(null)).toBe(false);
  });
});

describe('absLovelace', () => {
  it('drops a leading minus and leaves positive values untouched', () => {
    expect(absLovelace('-100')).toBe('100');
    expect(absLovelace('100')).toBe('100');
    expect(absLovelace('0')).toBe('0');
  });
});

describe('buildPowerChart', () => {
  it('returns null for fewer than two points', () => {
    expect(buildPowerChart([])).toBeNull();
    expect(buildPowerChart([5])).toBeNull();
  });

  it('plots points left-to-right with an inverted y axis and a closed area', () => {
    const c = buildPowerChart([10, 20, 30], {
      width: 200,
      height: 100,
      padLeft: 0,
      padRight: 40,
      padTop: 10,
      padBottom: 20,
    });
    expect(c).not.toBeNull();
    expect(c!.plot).toEqual({ x: 0, y: 10, w: 160, h: 70 });
    const pts = c!.line.split(' ').map((p) => p.split(',').map(Number));
    expect(pts).toHaveLength(3);
    expect(pts[0][0]).toBeCloseTo(0); // first x at plot.x
    expect(pts[2][0]).toBeCloseTo(160); // last x at plot.x + plot.w
    expect(pts[2][1]).toBeLessThan(pts[0][1]); // larger value -> higher (smaller y)
    expect(c!.last).toEqual({ x: pts[2][0], y: pts[2][1] });
    // Area closes down to the plot baseline (y = plot.y + plot.h = 80).
    expect(c!.area.startsWith('M')).toBe(true);
    expect(c!.area.includes(',80')).toBe(true);
    expect(c!.area.trim().endsWith('Z')).toBe(true);
  });

  it('emits gridlines at the data min and max', () => {
    const c = buildPowerChart([10, 20, 30], { width: 200, height: 100 });
    expect(c!.yTicks.map((t) => t.value)).toEqual([10, 30]);
    const byVal = Object.fromEntries(c!.yTicks.map((t) => [t.value, t.y]));
    expect(byVal[30]).toBeLessThan(byVal[10]); // max higher on screen
  });

  it('centers a flat series with a single gridline', () => {
    const c = buildPowerChart([5, 5, 5], { width: 200, height: 100, padTop: 10, padBottom: 10 });
    expect(c!.yTicks).toHaveLength(1);
    expect(c!.yTicks[0].value).toBe(5);
    const ys = c!.line.split(' ').map((p) => Number(p.split(',')[1]));
    for (const y of ys) expect(y).toBeCloseTo(50); // plot.y + plot.h/2
  });

  it('renders a sub-percent move as a nearly-flat line, not a full-height swing', () => {
    // 1,000,000 -> 1,002,000 is a 0.2% wiggle. Auto-scaling would stretch it edge
    // to edge; the minimum span keeps its on-screen amplitude tiny.
    const c = buildPowerChart([1_000_000, 1_002_000], {
      width: 200,
      height: 100,
      padTop: 0,
      padBottom: 0,
      padLeft: 0,
      padRight: 0,
    })!;
    const ys = c.line.split(' ').map((p) => Number(p.split(',')[1]));
    // Both points sit near the vertical centre; the drop is a small fraction of height.
    for (const y of ys) expect(Math.abs(y - 50)).toBeLessThan(15);
    // A negligible move collapses to one reference line at the current level.
    expect(c.yTicks).toHaveLength(1);
    expect(c.yTicks[0].value).toBe(1_002_000);
  });

  it('lets a move larger than the minimum span scale naturally to the edges', () => {
    // 1,000,000 -> 1,200,000 is a 20% jump, well past the 8% floor: it should span
    // the plot like the un-clamped case, with distinct min/max gridlines.
    const c = buildPowerChart([1_000_000, 1_200_000], { width: 200, height: 100, padTop: 0, padBottom: 0 })!;
    expect(c.yTicks.map((t) => t.value)).toEqual([1_000_000, 1_200_000]);
    const ys = c.line.split(' ').map((p) => Number(p.split(',')[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(70); // spans most of the 100px height
  });

  it('respects a custom minSpanFrac', () => {
    // A generous floor flattens even a 5% move; the tight default would not.
    const wide = buildPowerChart([100, 105], { width: 200, height: 100, minSpanFrac: 0.5 })!;
    const wideYs = wide.line.split(' ').map((p) => Number(p.split(',')[1]));
    expect(wide.yTicks).toHaveLength(1); // clamped -> single reference line
    expect(Math.max(...wideYs) - Math.min(...wideYs)).toBeLessThan(20);
  });

  it('spaces points by their epoch-true positions when provided', () => {
    const c = buildPowerChart([10, 20, 30], {
      width: 200,
      height: 100,
      padLeft: 0,
      padRight: 0,
      padTop: 0,
      padBottom: 0,
      positions: [0, 0.25, 1],
    })!;
    const xs = c.line.split(' ').map((p) => Number(p.split(',')[0]));
    // A quarter of the plot width for the middle point, not a third: the sparse
    // series does not compress toward evenly-spaced index positions.
    expect(xs).toEqual([0, 50, 200]);
  });

  it('falls back to index spacing when positions has the wrong length', () => {
    const c = buildPowerChart([10, 20, 30], {
      width: 200,
      height: 100,
      padLeft: 0,
      padRight: 0,
      padTop: 0,
      padBottom: 0,
      positions: [0, 1],
    })!;
    const xs = c.line.split(' ').map((p) => Number(p.split(',')[0]));
    expect(xs).toEqual([0, 100, 200]);
  });
});

describe('buildOverlaySeries', () => {
  const chart = buildPowerChart([10, 20, 30, 40], {
    width: 200,
    height: 100,
    padLeft: 0,
    padRight: 0,
    padTop: 0,
    padBottom: 0,
  })!;

  it('returns null when fewer than two values are present', () => {
    expect(buildOverlaySeries([null, null, null, 5], chart)).toBeNull();
    expect(buildOverlaySeries([null], chart)).toBeNull();
  });

  it('draws only the trailing run and reports its span', () => {
    const o = buildOverlaySeries([null, null, 100, 130], chart)!;
    expect(o.points).toBe(2);
    expect(o.firstValue).toBe(100);
    expect(o.lastValue).toBe(130);
    // Two points on a four-point grid: the run starts two thirds along the plot.
    expect(o.line.split(' ').map((p) => p.split(',')[0])).toEqual(['133.33', '200']);
  });

  it('cuts the line at a gap instead of interpolating across it', () => {
    const o = buildOverlaySeries([100, null, 120, 130], chart)!;
    expect(o.points).toBe(2);
    expect(o.firstValue).toBe(120);
  });

  it('scales to its own domain, not the chart values', () => {
    // Counts three orders of magnitude below the power values still use the full
    // plot height: lowest point at the bottom, highest at the top.
    const o = buildOverlaySeries([100, 200, 300, 400], chart)!;
    const ys = o.line.split(' ').map((p) => Number(p.split(',')[1]));
    expect(ys[0]).toBeGreaterThan(ys[ys.length - 1]);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(o.last).toEqual({ x: 200, y: ys[ys.length - 1] });
  });

  it('keeps a flat headcount off the edges', () => {
    const o = buildOverlaySeries([50, 50, 50, 50], chart)!;
    const ys = o.line.split(' ').map((p) => Number(p.split(',')[1]));
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeCloseTo(50, 5);
  });

  it('does not stretch a one-delegator wiggle across the plot', () => {
    const o = buildOverlaySeries([1000, 1001, 1000, 1001], chart)!;
    const ys = o.line.split(' ').map((p) => Number(p.split(',')[1]));
    // The 8% minimum span keeps a 0.1% move visually small.
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(5);
  });
});

describe('buildOverlaySeries small-count floor', () => {
  const chart = buildPowerChart([10, 20], {
    width: 200,
    height: 100,
    padLeft: 0,
    padRight: 0,
    padTop: 0,
    padBottom: 0,
  })!;

  it('keeps one delegator joining a small DRep from filling the plot', () => {
    const o = buildOverlaySeries([8, 9], chart)!;
    const ys = o.line.split(' ').map((p) => Number(p.split(',')[1]));
    const travelled = (Math.abs(ys[0] - ys[1]) / 100) * 100;
    // One of four visible units: a clear step, not a cliff edge to edge.
    expect(travelled).toBeGreaterThan(15);
    expect(travelled).toBeLessThan(35);
  });

  it('lets a move larger than the floor scale naturally', () => {
    const o = buildOverlaySeries([10, 40], chart)!;
    const ys = o.line.split(' ').map((p) => Number(p.split(',')[1]));
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThan(70);
  });
});

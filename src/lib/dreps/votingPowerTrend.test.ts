import { describe, it, expect } from 'vitest';
import { computeVotingPowerDelta, formatTrendPct, absLovelace, buildPowerChart } from './votingPowerTrend.js';

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
});

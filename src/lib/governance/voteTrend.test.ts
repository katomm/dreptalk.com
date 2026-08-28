import { describe, it, expect } from 'vitest';
import {
  buildTrendChart,
  type TrendSeries,
  computeVoteTrendSeries,
  type TrendBodyInput,
  toRelativeSeries,
  sharedTrendBodies,
  buildCompareView,
} from './voteTrend.js';

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

const DAY = 86_400;

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

describe('toRelativeSeries', () => {
  it('shifts every point so the origin becomes t = 0', () => {
    const s = series({ points: [{ t: 1000, pct: 0 }, { t: 1600, pct: 50 }] });
    const out = toRelativeSeries([s], 1000);
    expect(out[0].points.map((p) => p.t)).toEqual([0, 600]);
    expect(out[0].points.map((p) => p.pct)).toEqual([0, 50]);
  });

  it('keeps key, threshold, label and dashed flag intact', () => {
    const s = series({ dashed: true });
    const out = toRelativeSeries([s], 0);
    expect(out[0].key).toBe('DRep');
    expect(out[0].thresholdPct).toBe(67);
    expect(out[0].finalLabel).toBe('80%');
    expect(out[0].dashed).toBe(true);
  });

  it('does not mutate the input series', () => {
    const s = series({ points: [{ t: 500, pct: 0 }, { t: 900, pct: 10 }] });
    toRelativeSeries([s], 500);
    expect(s.points[0].t).toBe(500);
  });
});

describe('sharedTrendBodies', () => {
  it('keeps only the bodies both sides have, on both sides', () => {
    const own = [series({ key: 'DRep' }), series({ key: 'SPO' })];
    const cmp = [series({ key: 'SPO' }), series({ key: 'CC' })];
    const out = sharedTrendBodies(own, cmp);
    expect(out.own.map((s) => s.key)).toEqual(['SPO']);
    expect(out.compare.map((s) => s.key)).toEqual(['SPO']);
  });

  it('returns two empty lists when the sides have no body in common', () => {
    const out = sharedTrendBodies([series({ key: 'DRep' })], [series({ key: 'SPO' })]);
    expect(out.own).toEqual([]);
    expect(out.compare).toEqual([]);
  });

  it('preserves the input order of the surviving series', () => {
    const own = [series({ key: 'CC' }), series({ key: 'DRep' })];
    const cmp = [series({ key: 'DRep' }), series({ key: 'CC' })];
    expect(sharedTrendBodies(own, cmp).own.map((s) => s.key)).toEqual(['CC', 'DRep']);
  });

  it('is a no-op when both sides carry the same bodies', () => {
    const own = [series({ key: 'DRep' }), series({ key: 'SPO' })];
    const out = sharedTrendBodies(own, [series({ key: 'DRep' }), series({ key: 'SPO' })]);
    expect(out.own).toHaveLength(2);
  });
});

describe('computeVoteTrendSeries dashed', () => {
  it('carries the dashed flag from the body input onto the series', () => {
    const input: TrendBodyInput = {
      key: 'DRep',
      yesVotes: [{ blockTime: 50, weight: 10 }],
      finalPct: 60,
      thresholdPct: null,
      finalLabel: '60%',
      dashed: true,
    };
    const out = computeVoteTrendSeries([input], { start: 0, end: 100 });
    expect(out[0].dashed).toBe(true);
  });

  it('leaves dashed undefined when the input does not set it', () => {
    const input: TrendBodyInput = {
      key: 'DRep',
      yesVotes: [{ blockTime: 50, weight: 10 }],
      finalPct: 60,
      thresholdPct: null,
      finalLabel: '60%',
    };
    expect(computeVoteTrendSeries([input], { start: 0, end: 100 })[0].dashed).toBeUndefined();
  });
});

describe('buildTrendChart compare support', () => {
  it('defaults dashed to false and carries an explicit true through', () => {
    const c = buildTrendChart([series(), series({ key: 'SPO', dashed: true })], { domain: [0, 100] })!;
    expect(c.series[0].dashed).toBe(false);
    expect(c.series[1].dashed).toBe(true);
  });

  it('maps requested markers onto the same x scale as the series', () => {
    const c = buildTrendChart([series()], {
      width: 200, height: 100, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
      domain: [0, 100], markers: [50],
    })!;
    expect(c.markers).toEqual([{ t: 50, x: 100 }]);
  });

  it('returns an empty marker list when none are requested', () => {
    const c = buildTrendChart([series()], { domain: [0, 100] })!;
    expect(c.markers).toEqual([]);
  });

  it('clamps a marker outside the domain into the plot', () => {
    const c = buildTrendChart([series()], {
      width: 200, height: 100, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
      domain: [0, 100], markers: [140],
    })!;
    expect(c.markers[0].x).toBe(200);
  });
});

describe('buildCompareView', () => {
  const opts = {
    start: 1000,
    end: 1000 + 10 * DAY,
    lineEnd: 1000 + 10 * DAY,
    ownIsTerminal: true,
    compareStart: 500_000,
    compareEnd: 500_000 + 4 * DAY,
  };
  const ownDrep = series({ key: 'DRep', points: [{ t: 1000, pct: 0 }, { t: 1000 + 10 * DAY, pct: 80 }] });
  const ownSpo = series({ key: 'SPO', points: [{ t: 1000, pct: 0 }, { t: 1000 + 10 * DAY, pct: 60 }] });
  const cmpDrep = series({
    key: 'DRep',
    dashed: true,
    points: [{ t: 500_000, pct: 0 }, { t: 500_000 + 4 * DAY, pct: 55 }],
  });

  it('re-bases each side by ITS OWN window start, not by one shared origin', () => {
    const v = buildCompareView([ownDrep], [cmpDrep], opts);
    // Both curves must begin at day 0. A single shared origin would push the
    // compared action to t = 499000 and off the plot entirely.
    expect(v.series[0].points[0].t).toBe(0);
    expect(v.compareSeries[0].points[0].t).toBe(0);
    expect(v.compareSeries[0].points[1].t).toBe(4 * DAY);
  });

  it('spans the axis across the longer action so neither is clipped', () => {
    const longCompare = { ...opts, compareEnd: 500_000 + 30 * DAY };
    const v = buildCompareView([ownDrep], [cmpDrep], longCompare);
    expect(v.domain).toEqual([0, 30 * DAY]);
    // And the other way round, when the own action is the longer one.
    expect(buildCompareView([ownDrep], [cmpDrep], opts).domain).toEqual([0, 10 * DAY]);
  });

  it('never places a Today marker on a terminal action', () => {
    const v = buildCompareView([ownDrep], [cmpDrep], { ...opts, ownIsTerminal: true, lineEnd: 1000 + 3 * DAY });
    expect(v.markers).toEqual([]);
  });

  it('places a Today marker on an open action whose line stops short of the deadline', () => {
    const v = buildCompareView([ownDrep], [cmpDrep], { ...opts, ownIsTerminal: false, lineEnd: 1000 + 3 * DAY });
    expect(v.markers).toEqual([3 * DAY]);
  });

  it('places no marker on an open action whose line already reaches the deadline', () => {
    const v = buildCompareView([ownDrep], [cmpDrep], { ...opts, ownIsTerminal: false });
    expect(v.markers).toEqual([]);
  });

  it('falls back to exactly the non-compare shape when no body is shared', () => {
    const v = buildCompareView([ownSpo], [cmpDrep], opts);
    expect(v.relative).toBe(false);
    expect(v.series).toEqual([ownSpo]);
    expect(v.series[0].points[0].t).toBe(1000);
    expect(v.compareSeries).toEqual([]);
    expect(v.domain).toEqual([opts.start, opts.end]);
    expect(v.markers).toEqual([]);
    expect(v.droppedKeys).toEqual([]);
  });

  it('reports the own bodies the intersection removed', () => {
    const v = buildCompareView([ownDrep, ownSpo], [cmpDrep], opts);
    expect(v.series.map((s) => s.key)).toEqual(['DRep']);
    expect(v.droppedKeys).toEqual(['SPO']);
  });

  it('reports no dropped bodies when both sides carry the same ones', () => {
    const cmpSpo = series({ key: 'SPO', dashed: true, points: [{ t: 500_000, pct: 0 }, { t: 500_000 + DAY, pct: 20 }] });
    expect(buildCompareView([ownDrep, ownSpo], [cmpDrep, cmpSpo], opts).droppedKeys).toEqual([]);
  });

  it('does not mutate the input series', () => {
    buildCompareView([ownDrep], [cmpDrep], opts);
    expect(ownDrep.points[0].t).toBe(1000);
    expect(cmpDrep.points[0].t).toBe(500_000);
  });
});

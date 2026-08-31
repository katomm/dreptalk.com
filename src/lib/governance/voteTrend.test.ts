import { describe, it, expect } from 'vitest';
import {
  buildTrendChart,
  type TrendSeries,
  computeVoteTrendSeries,
  type TrendBodyInput,
  toRelativeSeries,
  sharedTrendBodies,
  buildCompareView,
  sampleSeriesAt,
  buildHoverBands,
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

  it('marks the own deadline when the compared window is longer and the action is open', () => {
    const longCompare = { ...opts, ownIsTerminal: false, lineEnd: 1000 + 3 * DAY, compareEnd: 500_000 + 30 * DAY };
    // The axis runs to day 30 but this action's voting ends at day 10. Without a
    // marker there, the empty space to day 30 reads as remaining voting time.
    expect(buildCompareView([ownDrep], [cmpDrep], longCompare).deadline).toBe(10 * DAY);
  });

  it('marks no deadline on a terminal action even under a longer compared window', () => {
    const longCompare = { ...opts, ownIsTerminal: true, compareEnd: 500_000 + 30 * DAY };
    expect(buildCompareView([ownDrep], [cmpDrep], longCompare).deadline).toBeNull();
  });

  it('marks no deadline when the own window is the longer or equal one', () => {
    // The axis already ends at the own deadline, a marker on the plot edge is noise.
    const v = buildCompareView([ownDrep], [cmpDrep], { ...opts, ownIsTerminal: false, lineEnd: 1000 + 3 * DAY });
    expect(v.deadline).toBeNull();
  });

  it('falls back to exactly the non-compare shape when no body is shared', () => {
    const v = buildCompareView([ownSpo], [cmpDrep], opts);
    expect(v.relative).toBe(false);
    expect(v.deadline).toBeNull();
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

describe('sampleSeriesAt', () => {
  // Step-after semantics: from point i-1 the line runs flat at pct i-1 until t_i,
  // then jumps. So the value AT t_i is pct_i, and anywhere between is the older pct.
  const step = (): TrendSeries => series({
    points: [
      { t: 0, pct: 0 },
      { t: 100, pct: 30 },
      { t: 200, pct: 75 },
    ],
  });

  it('returns the value the curve has already reached, never an interpolation', () => {
    // Half way between the 30 and 75 jumps the curve is still flat at 30. An
    // interpolating implementation would answer 52.5 here, which the chart never draws.
    expect(sampleSeriesAt(step(), 150)).toBe(30);
  });

  it('takes the new value exactly at a jump', () => {
    expect(sampleSeriesAt(step(), 100)).toBe(30);
    expect(sampleSeriesAt(step(), 200)).toBe(75);
  });

  it('returns the first point before the series starts', () => {
    expect(sampleSeriesAt(step(), -50)).toBe(0);
  });

  it('holds the final value past the end', () => {
    expect(sampleSeriesAt(step(), 10_000)).toBe(75);
  });

  it('returns 0 for an empty point list rather than throwing', () => {
    expect(sampleSeriesAt(series({ points: [] }), 10)).toBe(0);
  });
});

describe('buildHoverBands', () => {
  const DAY = 86_400;
  const plot = { x: 0, y: 0, w: 400, h: 200 };
  const ramp = (over: Partial<TrendSeries> = {}): TrendSeries => series({
    points: [
      { t: 0, pct: 0 },
      { t: 2 * DAY, pct: 40 },
      { t: 4 * DAY, pct: 80 },
    ],
    ...over,
  });

  it('emits one band per step plus the closing edge', () => {
    const bands = buildHoverBands([ramp()], { plot, domain: [0, 4 * DAY], step: DAY });
    expect(bands.map((b) => b.t)).toEqual([0, DAY, 2 * DAY, 3 * DAY, 4 * DAY]);
  });

  it('puts the crosshair on the sample point, not the band centre', () => {
    const bands = buildHoverBands([ramp()], { plot, domain: [0, 4 * DAY], step: DAY });
    expect(bands[0].lineX).toBe(0);
    expect(bands[2].lineX).toBe(200);
    expect(bands[4].lineX).toBe(400);
  });

  it('covers the whole plot width with no gap between bands', () => {
    const bands = buildHoverBands([ramp()], { plot, domain: [0, 4 * DAY], step: DAY });
    expect(bands[0].x).toBe(plot.x);
    const last = bands[bands.length - 1];
    expect(last.x + last.w).toBeCloseTo(plot.x + plot.w);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].x).toBeCloseTo(bands[i - 1].x + bands[i - 1].w);
    }
  });

  it('samples every series with step-after semantics', () => {
    const bands = buildHoverBands([ramp()], { plot, domain: [0, 4 * DAY], step: DAY });
    // Day 1 sits between the 0 and 40 jumps, so the curve is still at 0.
    expect(bands[1].samples).toEqual([{ key: 'DRep', pct: 0, dashed: false }]);
    expect(bands[2].samples[0].pct).toBe(40);
    expect(bands[4].samples[0].pct).toBe(80);
  });

  it('carries the dashed flag through so a row can be tied to the compared action', () => {
    const bands = buildHoverBands([ramp(), ramp({ key: 'SPO', dashed: true })], {
      plot, domain: [0, 4 * DAY], step: DAY,
    });
    expect(bands[0].samples.map((s) => s.dashed)).toEqual([false, true]);
  });

  it('flips the readout to the left of the crosshair past the plot midpoint', () => {
    const bands = buildHoverBands([ramp()], { plot, domain: [0, 4 * DAY], step: DAY });
    expect(bands[0].anchor).toBe('start');
    expect(bands[0].textX).toBeGreaterThan(bands[0].lineX);
    expect(bands[4].anchor).toBe('end');
    expect(bands[4].textX).toBeLessThan(bands[4].lineX);
  });

  it('coarsens the step instead of emitting an unbounded band count', () => {
    // A 400 day domain at one band per day would be 400 bands of markup on every
    // page view. The cap doubles the step until the count fits.
    const bands = buildHoverBands([ramp()], { plot, domain: [0, 400 * DAY], step: DAY });
    expect(bands.length).toBeLessThanOrEqual(41);
    expect(bands.length).toBeGreaterThan(1);
  });

  it('returns no bands for a degenerate domain', () => {
    expect(buildHoverBands([ramp()], { plot, domain: [0, 0], step: DAY })).toEqual([]);
  });

  it('returns no bands when there is nothing to read off', () => {
    expect(buildHoverBands([], { plot, domain: [0, 4 * DAY], step: DAY })).toEqual([]);
  });
});

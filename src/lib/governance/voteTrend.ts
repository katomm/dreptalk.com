// Pure model builders for the governance voting-trend chart. No I/O, no DOM.
// buildTrendChart maps per-body normalized step-series onto an SSR inline-SVG
// model in the style of buildPowerChart: a fixed 0..100 y axis, a shared time x
// axis, step-after paths (support is committed at a vote instant, so the line
// steps, never slopes), and dashed threshold lines on the same scale.

export type TrendBodyKey = 'DRep' | 'SPO' | 'CC';

export interface TrendPoint {
  /** Unix seconds. */
  t: number;
  /** 0..100, the normalized cumulative yes-support at t. */
  pct: number;
}

export interface TrendSeries {
  key: TrendBodyKey;
  /** Ascending by t, at least two points; first pct is 0, last is the final pct. */
  points: TrendPoint[];
  /** 0..100, or null when the action type has no on-chain threshold. */
  thresholdPct: number | null;
  /** Legend value, e.g. "78%" or "5 of 7". */
  finalLabel: string;
  /** Draw dotted instead of solid. Used for a compared action's overlay. */
  dashed?: boolean;
}

export interface TrendChartOptions {
  width?: number;
  height?: number;
  padLeft?: number;
  padRight?: number;
  padTop?: number;
  padBottom?: number;
  /** [tMin, tMax] unix seconds; defaults to the min/max t across all series. */
  domain?: [number, number];
  /** Extra t values to project onto the x scale, e.g. a "today" marker. */
  markers?: number[];
  /** The own action's voting deadline, projected like a marker but kept apart from
      the markers list so the view never has to tell the two kinds apart by value. */
  deadline?: number | null;
}

export interface TrendChartSeries {
  key: TrendBodyKey;
  stepPath: string;
  thresholdY: number | null;
  last: { x: number; y: number };
  finalLabel: string;
  dashed: boolean;
}

export interface TrendChart {
  width: number;
  height: number;
  plot: { x: number; y: number; w: number; h: number };
  series: TrendChartSeries[];
  yTicks: { value: number; y: number }[];
  xTicks: { t: number; x: number }[];
  markers: { t: number; x: number }[];
  /** x of the requested deadline on the plot, or null when none was requested. */
  deadlineX: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildTrendChart(series: TrendSeries[], opts: TrendChartOptions = {}): TrendChart | null {
  if (series.length === 0) return null;

  const width = opts.width ?? 640;
  const height = opts.height ?? 220;
  const padLeft = opts.padLeft ?? 8;
  const padRight = opts.padRight ?? 56;
  const padTop = opts.padTop ?? 16;
  const padBottom = opts.padBottom ?? 26;
  const plot = { x: padLeft, y: padTop, w: width - padLeft - padRight, h: height - padTop - padBottom };

  // Time domain: explicit, else the extent across every series' points.
  const allT = series.flatMap((s) => s.points.map((p) => p.t));
  const tMin = opts.domain ? opts.domain[0] : Math.min(...allT);
  const tMaxRaw = opts.domain ? opts.domain[1] : Math.max(...allT);
  const tMax = tMaxRaw > tMin ? tMaxRaw : tMin + 1; // guard a zero-width domain

  const xFor = (t: number): number => round2(plot.x + (plot.w * (t - tMin)) / (tMax - tMin));
  // Inverted y so 100% sits at the top; fixed 0..100 scale.
  const yFor = (pct: number): number => round2(plot.y + plot.h * (1 - Math.min(100, Math.max(0, pct)) / 100));

  const chartSeries: TrendChartSeries[] = series.map((s) => {
    const pts = s.points.map((p) => ({ x: xFor(p.t), y: yFor(p.pct) }));
    // Step-after: from each point move horizontally to the next point's x, then
    // vertically to its y. Support jumps at the vote instant, never slopes between.
    let d = `M ${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` H ${pts[i].x} V ${pts[i].y}`;
    }
    return {
      key: s.key,
      stepPath: d,
      thresholdY: s.thresholdPct == null ? null : yFor(s.thresholdPct),
      last: pts[pts.length - 1],
      finalLabel: s.finalLabel,
      dashed: s.dashed === true,
    };
  });

  const yTicks = [0, 25, 50, 75, 100].map((value) => ({ value, y: yFor(value) }));
  const xTicks = [tMin, tMax].map((t) => ({ t, x: xFor(t) }));
  // Markers ride the same x scale as the series so a caller never re-derives it.
  // Clamped, because a marker at "now" can sit a hair past a closed window.
  const markers = (opts.markers ?? []).map((t) => ({
    t,
    x: xFor(Math.min(Math.max(t, tMin), tMax)),
  }));
  const deadlineX = opts.deadline == null ? null : xFor(Math.min(Math.max(opts.deadline, tMin), tMax));

  return { width, height, plot, series: chartSeries, yTicks, xTicks, markers, deadlineX };
}

export interface TrendVote {
  blockTime: number;
  /** Lovelace (DRep/SPO) or 1 (CC). */
  weight: number;
}

export interface TrendBodyInput {
  key: TrendBodyKey;
  /** Final yes votes only, any order; weight already resolved per body. */
  yesVotes: TrendVote[];
  /** Stored ratification pct for this body (0..100), or null when unknown. */
  finalPct: number | null;
  thresholdPct: number | null;
  finalLabel: string;
  /** Marks this body as a compared action's overlay, drawn dotted. */
  dashed?: boolean;
}

/**
 * Turns per-body final yes votes into normalized step-series. Each vote adds its
 * weight; the running total is scaled so the curve ends at exactly the stored
 * final pct (per-voter weight enters only as a ratio, so power-drift never moves
 * the endpoint). A body with no yes weight or an unknown final pct is dropped.
 */
export function computeVoteTrendSeries(
  bodies: TrendBodyInput[],
  window: { start: number; end: number },
): TrendSeries[] {
  const out: TrendSeries[] = [];
  for (const b of bodies) {
    if (b.finalPct == null || b.yesVotes.length === 0) continue;
    // Lovelace is summed as a plain Number here deliberately: power only ever enters
    // as the ratio finalPct * cum / total, and the endpoint is separately pinned to
    // the stored finalPct, so float precision on the running sum never matters.
    const total = b.yesVotes.reduce((sum, v) => sum + v.weight, 0);
    if (total <= 0) continue;

    const sorted = [...b.yesVotes].sort((a, c) => a.blockTime - c.blockTime);
    const points: TrendPoint[] = [{ t: window.start, pct: 0 }];
    let cum = 0;
    for (const v of sorted) {
      cum += v.weight;
      // Clamp t into the window so a vote stamped a hair outside never escapes the plot.
      const t = Math.min(Math.max(v.blockTime, window.start), window.end);
      points.push({ t, pct: round2((b.finalPct * cum) / total) });
    }
    points.push({ t: window.end, pct: round2(b.finalPct) });
    out.push({ key: b.key, points, thresholdPct: b.thresholdPct, finalLabel: b.finalLabel, dashed: b.dashed });
  }
  return out;
}

/**
 * Re-bases every series onto seconds-since-origin. Two actions with different
 * calendar windows only become comparable once both start at t = 0, so the
 * compare overlay shifts both sides instead of teaching the chart about time.
 */
export function toRelativeSeries(series: TrendSeries[], origin: number): TrendSeries[] {
  return series.map((s) => ({
    ...s,
    points: s.points.map((p) => ({ t: p.t - origin, pct: p.pct })),
  }));
}

/**
 * Narrows both sides to the voting bodies they have in common. A lone dotted SPO
 * line under an action that never had an SPO vote reads as this action's own data,
 * so a body missing on either side is dropped from both.
 */
export function sharedTrendBodies(
  own: TrendSeries[],
  compare: TrendSeries[],
): { own: TrendSeries[]; compare: TrendSeries[] } {
  const ownKeys = new Set(own.map((s) => s.key));
  const cmpKeys = new Set(compare.map((s) => s.key));
  return {
    own: own.filter((s) => cmpKeys.has(s.key)),
    compare: compare.filter((s) => ownKeys.has(s.key)),
  };
}

export interface CompareViewInput {
  /** Own voting window in unix seconds, and where the own line stops. */
  start: number;
  end: number;
  lineEnd: number;
  /**
   * Whether the own action's lifecycle is over. Passed in as a plain boolean on
   * purpose: "voting is over" is defined by isTerminalStatus in the view layer, and
   * this model never imports from the view or db layers to find that out.
   */
  ownIsTerminal: boolean;
  /** The compared action's own voting window in unix seconds. */
  compareStart: number;
  compareEnd: number;
}

export interface CompareView {
  /** The own action's series, re-based when an overlay is drawn. */
  series: TrendSeries[];
  /** The compared action's series, empty when nothing can be overlaid. */
  compareSeries: TrendSeries[];
  /** x domain for buildTrendChart: absolute seconds, or 0..span when relative. */
  domain: [number, number];
  /** "Today" marker positions on the same scale as domain. */
  markers: number[];
  /**
   * The own action's voting deadline on the domain scale, or null. Set only when the
   * compared window runs longer AND the own action is still open: the axis then
   * extends past the own deadline, and without a marker there the empty space to the
   * axis end reads as remaining voting time.
   */
  deadline: number | null;
  /** True when both sides were re-based to seconds-since-their-own-window-start. */
  relative: boolean;
  /** Own bodies the intersection removed, so the view can say what vanished and why. */
  droppedKeys: TrendBodyKey[];
}

/**
 * The CompareView with nothing overlaid: absolute domain, no markers, not relative.
 * Both the component's non-compare default and buildCompareView's empty-intersection
 * fallback are THIS shape, structurally, so the two can never drift apart.
 */
export function plainCompareView(series: TrendSeries[], start: number, end: number): CompareView {
  return { series, compareSeries: [], domain: [start, end], markers: [], deadline: null, relative: false, droppedKeys: [] };
}

/**
 * The whole compare decision in one pure place: intersect the bodies, re-base each
 * side by ITS OWN window start so day 0 of both windows is the same x, span the axis
 * across whichever action ran longer, and place a "Today" marker only while the own
 * action is genuinely still open. When nothing survives the intersection this returns
 * exactly the non-compare shape, so the fallback cannot drift from the plain chart.
 */
export function buildCompareView(
  own: TrendSeries[],
  compare: TrendSeries[],
  o: CompareViewInput,
): CompareView {
  const shared = sharedTrendBodies(own, compare);
  if (shared.own.length === 0) {
    return plainCompareView(own, o.start, o.end);
  }
  const keptKeys = new Set(shared.own.map((s) => s.key));
  const ownSpan = o.end - o.start;
  const cmpSpan = o.compareEnd - o.compareStart;
  // The marker is gated on the lifecycle status, not on the shape of the data.
  // `lineEnd < end` alone is a proxy for "still voting", and a proxy is what puts a
  // "Today" label in the middle of a long-decided action.
  const showNow = !o.ownIsTerminal && o.lineEnd < o.end;
  return {
    series: toRelativeSeries(shared.own, o.start),
    compareSeries: toRelativeSeries(shared.compare, o.compareStart),
    // Never clip the longer action: the axis spans whichever window ran longer.
    domain: [0, Math.max(ownSpan, cmpSpan, 1)],
    markers: showNow ? [o.lineEnd - o.start] : [],
    // Only while open and only when the axis outruns the own window: on a terminal
    // action the endpoint dot already closes the story, and when the own window is
    // the longer one the deadline is the plot's right edge anyway.
    deadline: !o.ownIsTerminal && cmpSpan > ownSpan ? ownSpan : null,
    relative: true,
    droppedKeys: own.filter((s) => !keptKeys.has(s.key)).map((s) => s.key),
  };
}

/**
 * The value a step-after curve has at t: the last point at or before t, never an
 * interpolation between two points. Support is committed at a vote instant, so
 * between two votes the curve is flat and the honest reading is the older value.
 */
export function sampleSeriesAt(series: TrendSeries, t: number): number {
  const pts = series.points;
  if (pts.length === 0) return 0;
  let pct = pts[0].pct;
  for (const p of pts) {
    if (p.t > t) break;
    pct = p.pct;
  }
  return pct;
}

export interface HoverSample {
  key: TrendBodyKey;
  /** 0..100, the value every series has at this band's sample point. */
  pct: number;
  /** True for a compared action's series, so the row can be marked as such. */
  dashed: boolean;
}

export interface HoverBand {
  /** Hit area on the plot. Bands tile the plot width with no gap. */
  x: number;
  w: number;
  /** Crosshair position: the sample point itself, not the band centre. */
  lineX: number;
  /** Domain value this band reads off, for the caller to label. */
  t: number;
  /** Where the readout text starts, and how it anchors, so it never leaves the plot. */
  textX: number;
  anchor: 'start' | 'end';
  samples: HoverSample[];
}

export interface HoverBandOptions {
  plot: { x: number; y: number; w: number; h: number };
  domain: [number, number];
  /** Seconds between sample points, e.g. one day. Coarsened when it would not fit. */
  step: number;
}

/** Sample points beyond this would put more markup on the page than the readout is worth. */
const MAX_HOVER_BANDS = 41;
/** Gap in scale units between the crosshair and its readout text. */
const READOUT_GAP = 6;

/**
 * Vertical hit areas for a CSS-only hover readout, one per sample point, each
 * carrying every series' value at that point. Pure geometry plus sampling, so the
 * component only has to render it: there is no client-side JavaScript involved.
 */
export function buildHoverBands(series: TrendSeries[], opts: HoverBandOptions): HoverBand[] {
  const [tMin, tMax] = opts.domain;
  const span = tMax - tMin;
  if (series.length === 0 || span <= 0 || opts.step <= 0) return [];

  // Coarsen rather than emit hundreds of bands: an unusually long window would
  // otherwise put one group of markup per day on every page view.
  let step = opts.step;
  while (span / step > MAX_HOVER_BANDS - 1) step *= 2;

  const ts: number[] = [];
  for (let t = tMin; t < tMax; t += step) ts.push(t);
  ts.push(tMax); // the closing edge, so the deadline itself is always readable

  const xFor = (t: number): number => round2(opts.plot.x + (opts.plot.w * (t - tMin)) / span);
  const mid = opts.plot.x + opts.plot.w / 2;

  return ts.map((t, i) => {
    const lineX = xFor(t);
    // Each band owns the space up to the midpoint between it and its neighbours, so
    // the nearest sample point is always the one under the cursor.
    const left = i === 0 ? opts.plot.x : round2((xFor(ts[i - 1]) + lineX) / 2);
    const right = i === ts.length - 1 ? opts.plot.x + opts.plot.w : round2((lineX + xFor(ts[i + 1])) / 2);
    const anchor: 'start' | 'end' = lineX > mid ? 'end' : 'start';
    return {
      x: left,
      w: round2(right - left),
      lineX,
      t,
      textX: anchor === 'end' ? lineX - READOUT_GAP : lineX + READOUT_GAP,
      anchor,
      samples: series.map((s) => ({ key: s.key, pct: sampleSeriesAt(s, t), dashed: s.dashed === true })),
    };
  });
}

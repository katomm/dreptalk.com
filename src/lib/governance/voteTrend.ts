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
}

export interface TrendChartSeries {
  key: TrendBodyKey;
  stepPath: string;
  thresholdY: number | null;
  last: { x: number; y: number };
  finalLabel: string;
}

export interface TrendChart {
  width: number;
  height: number;
  plot: { x: number; y: number; w: number; h: number };
  series: TrendChartSeries[];
  yTicks: { value: number; y: number }[];
  xTicks: { t: number; x: number }[];
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
    };
  });

  const yTicks = [0, 25, 50, 75, 100].map((value) => ({ value, y: yFor(value) }));
  const xTicks = [tMin, tMax].map((t) => ({ t, x: xFor(t) }));

  return { width, height, plot, series: chartSeries, yTicks, xTicks };
}

// Pure helpers for the DRep voting-power trend: the per-epoch delta shown as a
// chip in the directory list, the small SSR sparkline on the profile page, and
// the shared rule for when a percentage is worth showing at all, which the epoch
// digest applies to its own wording. No I/O, no DOM; everything here is
// deterministic and unit-tested.
import { formatAdaCompact } from '../format/ada.js';

export interface VotingPowerDelta {
  /** Whether the latest snapshot rose, fell, or held versus the previous epoch. */
  direction: 'up' | 'down' | 'flat';
  /**
   * Relative change versus the previous snapshot, in percent (signed). Null when
   * the previous snapshot was zero, so the caller shows the absolute change alone
   * rather than dividing by zero.
   */
  pct: number | null;
  /** Absolute change in lovelace (signed), as an exact integer string. */
  deltaLovelace: string;
}

/** Parses a lovelace string to BigInt, or null when absent/non-numeric. */
function toLovelace(value: string | null): bigint | null {
  if (value == null || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * The change of a DRep's voting power from the previous epoch snapshot to the
 * latest one. Returns null when either snapshot is missing or non-numeric (a new
 * DRep with no previous epoch shows no chip). Lovelace math is done in BigInt so
 * no precision is lost; the percent is a ratio where Number is exact enough.
 */
export function computeVotingPowerDelta(
  snapshot: string | null,
  prev: string | null,
): VotingPowerDelta | null {
  const cur = toLovelace(snapshot);
  const before = toLovelace(prev);
  if (cur == null || before == null) return null;

  const delta = cur - before;
  const direction = delta > 0n ? 'up' : delta < 0n ? 'down' : 'flat';
  const pct = before > 0n ? (Number(delta) / Number(before)) * 100 : null;
  return { direction, pct, deltaLovelace: delta.toString() };
}

/**
 * Formats a signed percent for the trend chip. The sign is conveyed by the arrow
 * and color, so the label is unsigned: one decimal, an exact zero as "0%", and a
 * sub-0.1% nonzero change as "<0.1%" rather than a misleading "0.0%".
 */
export function formatTrendPct(pct: number): string {
  const abs = Math.abs(pct);
  if (abs === 0) return '0%';
  if (abs < 0.1) return '<0.1%';
  return `${abs.toFixed(1)}%`;
}

/**
 * Above this relative change a percentage stops informing. A DRep whose first
 * snapshot caught them at their own few ₳ before any delegation arrived shows
 * five- or six-digit percentages forever after, which reads as a broken widget
 * rather than as growth. Only gains can cross it: a loss bottoms out at -100%.
 */
export const PCT_DISPLAY_CAP = 1000;

/** Whether a percent is worth putting in front of a reader, see {@link PCT_DISPLAY_CAP}. */
export function pctIsMeaningful(pct: number | null): pct is number {
  return pct !== null && Math.abs(pct) < PCT_DISPLAY_CAP;
}

export interface TrendDisplay {
  /**
   * The relative change, or null when it would be meaningless: no previous
   * snapshot to divide by, or a figure past {@link PCT_DISPLAY_CAP}.
   */
  pct: string | null;
  /** The absolute change, which is always available. */
  ada: string;
}

/**
 * Both labels for a delta, unsigned (the sign rides on the delta's direction).
 * Callers lead with {@link TrendDisplay.pct} and fall back to the amount, which
 * for a young DRep is the honest and the more encouraging half of the same fact
 * anyway. Null when nothing moved and no percent exists, which has nothing to
 * show at all.
 */
export function formatTrendDelta(delta: VotingPowerDelta | null): TrendDisplay | null {
  if (!delta) return null;
  const ada = formatAdaCompact(absLovelace(delta.deltaLovelace));
  if (ada === null) return null;
  if (pctIsMeaningful(delta.pct)) return { pct: formatTrendPct(delta.pct), ada };
  return delta.direction === 'flat' ? null : { pct: null, ada };
}

/**
 * Drops a leading minus from a signed lovelace string for absolute-value display:
 * the chip's arrow and color already carry the direction.
 */
export function absLovelace(signed: string): string {
  return signed.startsWith('-') ? signed.slice(1) : signed;
}

export interface PowerChartTick {
  /** The data value (lovelace) this gridline marks. */
  value: number;
  /** Its y coordinate in the chart's user space. */
  y: number;
}

export interface PowerChart {
  width: number;
  height: number;
  /** Inner plot rectangle the line is drawn within (insets reserve axis-label space). */
  plot: { x: number; y: number; w: number; h: number };
  /** Polyline "x,y x,y ..." (oldest epoch first). */
  line: string;
  /** Filled-area path: the line, then down to the plot baseline and closed. */
  area: string;
  /** Most recent point, for the terminal dot. */
  last: { x: number; y: number };
  /** Horizontal gridlines at the data min and max (one when flat). */
  yTicks: PowerChartTick[];
}

export interface PowerChartOptions {
  width?: number;
  height?: number;
  padLeft?: number;
  padRight?: number;
  padTop?: number;
  padBottom?: number;
  /**
   * Minimum visible y span as a fraction of the latest value. Guarantees the plot
   * shows at least this much headroom so a tiny epoch-to-epoch wiggle renders as a
   * nearly-flat line instead of being auto-stretched edge to edge. Default 0.08
   * (the window covers at least +/-4% of the current voting power); a move larger
   * than this scales naturally and fills the plot.
   */
  minSpanFrac?: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Maps a series of values (oldest first) to an area-chart model: the line, a
 * baseline-closed area path for the gradient fill, the terminal point, and two
 * horizontal gridlines at the data min and max (one when flat). The y axis is
 * inverted so larger values sit higher; insets reserve room for axis labels.
 * Returns null for fewer than two points (a single dot is not a trend).
 */
export function buildPowerChart(values: number[], opts: PowerChartOptions = {}): PowerChart | null {
  if (values.length < 2) return null;
  const width = opts.width ?? 640;
  const height = opts.height ?? 200;
  const padLeft = opts.padLeft ?? 6;
  const padRight = opts.padRight ?? 56;
  const padTop = opts.padTop ?? 16;
  const padBottom = opts.padBottom ?? 26;

  const plot = { x: padLeft, y: padTop, w: width - padLeft - padRight, h: height - padTop - padBottom };

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const range = dataMax - dataMin;
  // Headroom so the line never touches the top/bottom edges. A flat series gets a
  // nominal band so it sits on the centre line.
  const pad = range === 0 ? Math.max(Math.abs(dataMin), 1) * 0.1 : range * 0.12;
  let lo = dataMin - pad;
  let hi = dataMax + pad;

  // Enforce a minimum visible span relative to the latest value. Without this the
  // domain hugs the data range, so a sub-percent epoch move gets stretched to fill
  // the plot and reads as a dramatic swing. Expanding symmetrically around the
  // data's midpoint keeps a small move looking small and a large move looking large.
  const latest = values[values.length - 1];
  const minSpan = Math.abs(latest) * (opts.minSpanFrac ?? 0.08);
  const clamped = minSpan > hi - lo;
  if (clamped) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }

  const yFor = (v: number): number => round2(plot.y + plot.h * (1 - (v - lo) / (hi - lo)));
  const xFor = (i: number): number => round2(plot.x + (plot.w * i) / (values.length - 1));

  const pts = values.map((v, i) => ({ x: xFor(i), y: yFor(v) }));
  const line = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const baseline = round2(plot.y + plot.h);
  const area = `M ${pts[0].x},${baseline} L ${pts.map((p) => `${p.x},${p.y}`).join(' L ')} L ${pts[pts.length - 1].x},${baseline} Z`;

  // A negligible move (or a truly flat series) collapses to a single reference line
  // at the current level: two near-identical min/max labels stacked at the centre
  // would just look like a glitch.
  const tickValues = range === 0 || clamped ? [latest] : [dataMin, dataMax];
  const yTicks = tickValues.map((value) => ({ value, y: yFor(value) }));

  return { width, height, plot, line, area, last: pts[pts.length - 1], yTicks };
}

/**
 * Smallest y span an overlay ever shows, in the overlay's own unit. Sized for a
 * delegator headcount: with four visible, a single delegator arriving takes a
 * quarter of the plot height, which is a step you notice without it reading as a
 * collapse or a doubling.
 */
export const DEFAULT_MIN_COUNT_SPAN = 4;

export interface OverlaySeries {
  /** Polyline "x,y x,y ..." over the plotted points, oldest first. */
  line: string;
  /** The newest plotted point, for the terminal dot. */
  last: { x: number; y: number };
  /** Value at the newest plotted point. */
  lastValue: number;
  /** Value at the oldest plotted point, so callers can label the drawn span. */
  firstValue: number;
  /** How many points were drawn. Fewer than the chart's when the series starts late. */
  points: number;
}

/**
 * A second series drawn over an existing {@link PowerChart}, on the same x grid
 * but with its own y domain. Voting power (lovelace, ~10^15) and a delegator
 * headcount (~10^3) share no scale: put the count on the power axis and it is a
 * flat line on the floor, so the overlay maps its own min/max into the same plot
 * rectangle and the caller labels it separately.
 *
 * `values` must be index-aligned with the series the chart was built from, one
 * entry per epoch, null where no value was recorded. Only the run of consecutive
 * values ending at the newest one is drawn: the delegator count exists only from
 * the epoch the stamp started, and bridging a gap with a straight line would
 * invent data. Returns null for fewer than two points (see buildPowerChart).
 */
export function buildOverlaySeries(
  values: (number | null)[],
  chart: PowerChart,
  opts: { minSpanFrac?: number; minSpanAbs?: number } = {},
): OverlaySeries | null {
  if (values.length < 2) return null;

  // Walk back from the newest entry while values keep coming, so a gap in the
  // middle cuts the line rather than being interpolated across.
  let start = values.length;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) break;
    start = i;
  }
  const run = values.slice(start) as number[];
  if (run.length < 2) return null;

  const dataMin = Math.min(...run);
  const dataMax = Math.max(...run);
  const range = dataMax - dataMin;
  const pad = range === 0 ? Math.max(Math.abs(dataMin), 1) * 0.1 : range * 0.12;
  let lo = dataMin - pad;
  let hi = dataMax + pad;

  // Same headroom rule as the main chart: a headcount that barely moved should
  // read as barely moved, not get stretched across the full plot height. A count
  // also needs an absolute floor, which a ratio cannot give it: a DRep going from
  // 8 delegators to 9 is a 12.5% move, and scaled by ratio alone that one person
  // joining would climb the full height of the plot like a doubling of power.
  const latest = run[run.length - 1];
  const minSpan = Math.max(
    Math.abs(latest) * (opts.minSpanFrac ?? 0.08),
    opts.minSpanAbs ?? DEFAULT_MIN_COUNT_SPAN,
  );
  if (minSpan > hi - lo) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }

  const { plot } = chart;
  const yFor = (v: number): number => round2(plot.y + plot.h * (1 - (v - lo) / (hi - lo)));
  const xFor = (i: number): number => round2(plot.x + (plot.w * i) / (values.length - 1));

  const pts = run.map((v, i) => ({ x: xFor(start + i), y: yFor(v) }));
  return {
    line: pts.map((p) => `${p.x},${p.y}`).join(' '),
    last: pts[pts.length - 1],
    lastValue: latest,
    firstValue: run[0],
    points: run.length,
  };
}

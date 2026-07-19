// Pure helpers for the DRep voting-power trend: the per-epoch delta shown as a
// chip in the directory list, and the small SSR sparkline on the profile page.
// No I/O, no DOM; everything here is deterministic and unit-tested.

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

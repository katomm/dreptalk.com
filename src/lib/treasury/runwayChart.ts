// SVG geometry of the runway chart: stored treasury balances as a solid line,
// the projection as a dashed line, one shared domain. Pure, so the server
// renders the first frame and the client script redraws only the projection.
// The x domain is fixed (first stored epoch to 25 years after the last closed
// one) so the axis never jumps while the slider moves. Projection values above
// the y domain are clipped to its top.

export const RUNWAY_CHART = { width: 640, height: 230, left: 60, right: 12, top: 12, bottom: 30 } as const;
const SPAN_EPOCHS = 25 * 73;
const STEP = 500_000_000_000_000n; // 0.5B ada in lovelace

export interface ChartFrame {
  lastClosedEpoch: number;
  epochStartSec: number;
  epochLengthSec: number;
}

export interface RunwayChartGeometry {
  historyPath: string;
  projectionPath: string;
  xTicks: { x: number; label: string }[];
  yTicks: { y: number; label: string }[];
  /** Domain, so the client can draw new projections in the same frame. */
  domain: { x0: number; x1: number; yMax: number };
}

type Point = { epoch: number; treasury: bigint };

function pathOf(points: Point[], sx: (e: number) => number, sy: (t: bigint) => number): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.epoch).toFixed(1)},${sy(p.treasury).toFixed(1)}`).join(' ');
}

export function scales(domain: RunwayChartGeometry['domain']) {
  const { width, height, left, right, top, bottom } = RUNWAY_CHART;
  const sx = (e: number) => left + ((e - domain.x0) / (domain.x1 - domain.x0)) * (width - left - right);
  const sy = (t: bigint) => {
    const v = Math.min(Math.max(Number(t), 0), domain.yMax);
    return top + (1 - v / domain.yMax) * (height - top - bottom);
  };
  return { sx, sy };
}

/** Projection path in an existing frame, for the client redraw. */
export function projectionPath(domain: RunwayChartGeometry['domain'], points: Point[]): string {
  const { sx, sy } = scales(domain);
  return pathOf(points, sx, sy);
}

export function runwayChart(frame: ChartFrame, history: Point[], projection: Point[]): RunwayChartGeometry {
  if (history.length === 0) return { historyPath: '', projectionPath: '', xTicks: [], yTicks: [], domain: { x0: 0, x1: 1, yMax: 1 } };
  const x0 = history[0].epoch;
  const x1 = frame.lastClosedEpoch + SPAN_EPOCHS;
  const maxT = history.reduce((m, p) => (p.treasury > m ? p.treasury : m), 0n);
  const steps = maxT <= 0n ? 1n : (maxT + STEP - 1n) / STEP;
  const yMax = Number(steps * STEP);
  const domain = { x0, x1, yMax };
  const { sx, sy } = scales(domain);

  const yearOf = (e: number) => new Date((frame.epochStartSec + (e - frame.lastClosedEpoch) * frame.epochLengthSec) * 1000).getUTCFullYear();
  const xTicks: { x: number; label: string }[] = [];
  const firstYear = yearOf(x0) + 1;
  const lastYear = yearOf(x1);
  const stride = lastYear - firstYear > 12 ? 5 : 1;
  for (let y = Math.ceil(firstYear / stride) * stride; y <= lastYear; y += stride) {
    const sec = Date.UTC(y, 0, 1) / 1000;
    const e = frame.lastClosedEpoch + (sec - frame.epochStartSec) / frame.epochLengthSec;
    if (e >= x0 && e <= x1) xTicks.push({ x: sx(e), label: String(y) });
  }
  const yTicks: { y: number; label: string }[] = [];
  for (let i = 0n; i <= steps; i++) yTicks.push({ y: sy(i * STEP), label: `${(Number(i * STEP) / 1e15).toFixed(1)}B` });

  return { historyPath: pathOf(history, sx, sy), projectionPath: pathOf(projection, sx, sy), xTicks, yTicks, domain };
}

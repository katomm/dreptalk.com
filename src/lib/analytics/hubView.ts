// Pure view model for the /analytics hub. All numbers arrive from D1 reads,
// this module only shapes them. Honesty rules live here: deltas are net
// change (never inflow or outflow), series are clipped to their contract
// start so a NULL never renders as a zero, and lovelace-to-Number conversion
// is display-only (documented precision).
import { formatAda } from '../forum/view.js';
import { RECENT_VOTING_WINDOW_EPOCHS } from './epochStatsContract.js';
import type { EpochStatsRow } from './epochStats.js';

export interface VitalCard {
  label: string;
  value: string;
  icon: 'people' | 'power' | 'gauge' | 'share';
  alt?: boolean;
  trend?: { direction: 'up' | 'down' | 'flat'; label: string } | null;
  sub?: string;
}

export interface NetChangeChip {
  label: string;
  direction: 'up' | 'down' | 'flat';
}

/** Signed net-change chip between two observations, null unless both exist. */
export function netChange(
  current: number | null,
  prev: number | null,
  format: (n: number) => string,
): NetChangeChip | null {
  if (current == null || prev == null) return null;
  const delta = current - prev;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';
  return { label: `${sign}${format(Math.abs(delta))} this epoch`, direction };
}

export type ChartableMetric =
  | 'totalDrepPower'
  | 'poweredDrepCount'
  | 'delegatorTotal'
  | 'abstainPower'
  | 'ancPower';

/**
 * Chart points for one metric, clipped to its reliable series start
 * (seriesStartEpoch resolved by the caller against the DB). Values become JS
 * numbers for chart geometry only, lovelace precision above 2^53 is
 * deliberately approximate here.
 */
export function metricSeries(
  rows: EpochStatsRow[],
  metric: ChartableMetric,
  startEpoch: number | null,
): { epoch: number; value: number }[] {
  if (startEpoch == null) return [];
  const out: { epoch: number; value: number }[] = [];
  for (const r of rows) {
    if (r.epoch < startEpoch) continue;
    const raw = r[metric];
    if (raw == null) continue;
    out.push({ epoch: r.epoch, value: Number(raw) });
  }
  return out;
}

function countTrend(current: number, prev: number | null): VitalCard['trend'] {
  const chip = netChange(current, prev, (n) => n.toLocaleString('en-US'));
  return chip ? { direction: chip.direction, label: chip.label } : null;
}

/**
 * Trend for the delegated-voting-power card. The delta is lovelace, so it is
 * formatted with formatAda (whole ada plus the currency symbol) instead of
 * toLocaleString, which would print an unreadable raw lovelace digit run.
 */
function powerTrend(current: string, prev: string | null): VitalCard['trend'] {
  const chip = netChange(
    Number(current),
    prev != null ? Number(prev) : null,
    (n) => formatAda(String(n)),
  );
  return chip ? { direction: chip.direction, label: chip.label } : null;
}

/** The four hub vitals. Empty array when no stats row exists yet. */
export function buildVitals(
  current: EpochStatsRow | null,
  prev: EpochStatsRow | null,
  circulationLovelace: string | null,
): VitalCard[] {
  if (!current) return [];
  let shareValue = 'n/a';
  if (circulationLovelace != null) {
    const circulation = Number(circulationLovelace);
    const total = Number(current.totalDrepPower);
    if (circulation > 0) shareValue = `${((total / circulation) * 100).toFixed(1)}%`;
  }
  return [
    {
      label: 'DReps with voting power',
      value: current.poweredDrepCount.toLocaleString('en-US'),
      icon: 'people',
      trend: countTrend(current.poweredDrepCount, prev?.poweredDrepCount ?? null),
    },
    {
      label: 'Voted in the last 12 epochs',
      value: current.recentlyVotingDrepCount.toLocaleString('en-US'),
      icon: 'gauge',
      alt: true,
      sub: `voted at least once in the last ${RECENT_VOTING_WINDOW_EPOCHS} epochs`,
    },
    {
      label: 'Delegated voting power',
      value: formatAda(current.totalDrepPower),
      icon: 'power',
      trend: powerTrend(current.totalDrepPower, prev ? prev.totalDrepPower : null),
    },
    {
      label: 'Share of circulating ada',
      value: shareValue,
      icon: 'share',
      alt: true,
      sub: 'delegated to DReps',
    },
  ];
}

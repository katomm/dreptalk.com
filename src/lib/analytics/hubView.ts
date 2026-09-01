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
  | 'ancPower'
  | 'gini'
  | 'top10SharePct'
  | 'minCoalition50'
  | 'minCoalition67';

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

/**
 * The longest gapless run of rows starting at the oldest one. During the
 * one-time epoch backfill the stored epochs are a growing prefix plus the
 * live current epoch, and a chart drawn across that hole would read the
 * connecting line as data. A complete series comes back unchanged, so this
 * is a no-op once the backfill has drained. Rows must be ascending by epoch
 * (listEpochStats order).
 */
export function contiguousPrefix(rows: EpochStatsRow[]): EpochStatsRow[] {
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].epoch !== rows[i - 1].epoch + 1) return rows.slice(0, i);
  }
  return rows;
}

/**
 * The row exactly one epoch behind the given one, or null. A positional
 * stats[length - 2] would pick an ancient backfilled epoch mid-drain and
 * feed the vitals and net-change chips a years-wide delta.
 */
export function rowBeforeEpoch(rows: EpochStatsRow[], epoch: number): EpochStatsRow | null {
  return rows.find((r) => r.epoch === epoch - 1) ?? null;
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
    if (Number.isFinite(circulation) && Number.isFinite(total) && circulation > 0) {
      shareValue = `${((total / circulation) * 100).toFixed(1)}%`;
    }
  }
  // The running epoch's vote data is provisional (vote_data_complete is only
  // set once the epoch has ended), so this card says so instead of quietly
  // showing a count that will still change. The guide explains the rule, this
  // sub only states it is in effect right now.
  const votingSub = current.voteDataComplete === false
    ? 'still filling in for the running epoch'
    : 'superseded votes included';
  return [
    {
      label: 'DReps with voting power',
      value: current.poweredDrepCount.toLocaleString('en-US'),
      icon: 'people',
      trend: countTrend(current.poweredDrepCount, prev?.poweredDrepCount ?? null),
      // The snapshot counts every power-holding row including retired DReps,
      // while the DRep activity section's count below is active-only. Without
      // this the two counts on the same page look like a contradiction.
      sub: 'including retired DReps still holding stake',
    },
    {
      label: `Voted in the last ${RECENT_VOTING_WINDOW_EPOCHS} epochs`,
      value: current.recentlyVotingDrepCount.toLocaleString('en-US'),
      icon: 'gauge',
      alt: true,
      sub: votingSub,
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

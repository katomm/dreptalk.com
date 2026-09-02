// Pure view model for the /analytics hub. All numbers arrive from D1 reads,
// this module only shapes them. Honesty rules live here: deltas are net
// change (never inflow or outflow), series are clipped to their contract
// start so a NULL never renders as a zero, and lovelace-to-Number conversion
// is display-only (documented precision).
import { formatAda } from '../forum/view.js';
import { formatAdaCompact } from '../format/ada.js';
import { RECENT_VOTING_WINDOW_EPOCHS, seriesStartFromRows } from './epochStatsContract.js';
import type { EpochStatsRow } from './epochStats.js';
import { hubHref } from './hubSections.js';

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
  | 'recentlyVotingDrepCount'
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
 * The gapless run of rows that ends at the newest one, the mirror of
 * contiguousPrefix for callers holding a trailing window. Mid-backfill the
 * older rows of such a window can be ancient epochs, and a line across that
 * hole would read as data.
 */
export function contiguousTail(rows: EpochStatsRow[]): EpochStatsRow[] {
  for (let i = rows.length - 1; i > 0; i -= 1) {
    if (rows[i].epoch !== rows[i - 1].epoch + 1) return rows.slice(i);
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

/**
 * Trend chip for a stat card: netChange over two observations with the given
 * formatter, null unless both exist. Number coercion is display-only, lovelace
 * above 2^53 is deliberately approximate here.
 */
function trendChip(
  current: number | string,
  prev: number | string | null,
  format: (n: number) => string,
): VitalCard['trend'] {
  return netChange(Number(current), prev == null ? null : Number(prev), format);
}
const formatCount = (n: number) => n.toLocaleString('en-US');
/** Whole ada with symbol, so a lovelace delta never prints as a raw digit run. */
const formatAdaDelta = (n: number) => formatAda(String(n));

/** Delegated power as a percentage of circulation, null when either side is unusable. */
function circulatingSharePct(totalDrepPower: string, circulationLovelace: string | null): number | null {
  if (circulationLovelace == null) return null;
  const circulation = Number(circulationLovelace);
  const total = Number(totalDrepPower);
  if (!Number.isFinite(circulation) || !Number.isFinite(total) || circulation <= 0) return null;
  return (total / circulation) * 100;
}

// The running epoch's vote data is provisional (vote_data_complete is only set
// once the epoch has ended), so cards say so instead of quietly showing a
// count that will still change. The guide explains the rule, this sub only
// states it is in effect right now.
const PROVISIONAL_VOTING_SUB = 'still filling in for the running epoch';
const votedLabel = () => `Voted in the last ${RECENT_VOTING_WINDOW_EPOCHS} epochs`;

/** The four hub vitals. Empty array when no stats row exists yet. */
export function buildVitals(
  current: EpochStatsRow | null,
  prev: EpochStatsRow | null,
  circulationLovelace: string | null,
): VitalCard[] {
  if (!current) return [];
  const share = circulatingSharePct(current.totalDrepPower, circulationLovelace);
  return [
    {
      label: 'DReps holding delegated power',
      value: formatCount(current.poweredDrepCount),
      icon: 'people',
      trend: trendChip(current.poweredDrepCount, prev?.poweredDrepCount ?? null, formatCount),
      // The snapshot counts every power-holding row including retired DReps,
      // while the DRep activity section's count below is active-only. Without
      // this the two counts on the same page look like a contradiction.
      sub: 'including retired DReps still holding stake',
    },
    {
      label: votedLabel(),
      value: formatCount(current.recentlyVotingDrepCount),
      icon: 'gauge',
      alt: true,
      sub: current.voteDataComplete === false ? PROVISIONAL_VOTING_SUB : 'superseded votes included',
    },
    {
      label: 'Delegated voting power',
      value: formatAda(current.totalDrepPower),
      icon: 'power',
      trend: trendChip(current.totalDrepPower, prev ? prev.totalDrepPower : null, formatAdaDelta),
    },
    {
      label: 'Share of circulating ada',
      value: share == null ? 'n/a' : `${share.toFixed(1)}%`,
      icon: 'share',
      alt: true,
      sub: 'delegated to DReps',
    },
  ];
}

/**
 * Sparkline values for one metric over a gapless row window (oldest first),
 * clipped to the metric's contract start so a NULL never draws as a zero.
 * Callers pass contiguousTail(rows) (or a further-trimmed slice of it).
 */
export function recentSeries(rows: EpochStatsRow[], metric: ChartableMetric): number[] {
  return metricSeries(rows, metric, seriesStartFromRows(rows, metric)).map((p) => p.value);
}

/** Epochs the homepage strip loads: enough for a sparkline, still a tiny read. */
export const GLANCE_WINDOW_EPOCHS = 12;

/**
 * One tile of the homepage's at-a-glance strip: a vital, the hub section it
 * jumps to, the metric's recent epoch series for a sparkline, and for a
 * share-of-whole value the donut percentage.
 */
export type GlanceTile = VitalCard & { href: string; series: number[]; ring?: number };

/**
 * The homepage's four at-a-glance tiles from a trailing window of epoch rows
 * (ascending). Built from the same parts as buildVitals but compact (the
 * strip is a quarter of the page wide), each linking straight into the hub
 * chapter that explains the number, each carrying the metric's series over
 * the gapless tail of the window, clipped to the metric's contract start so
 * a NULL never draws as a zero. The recent-voter series drops the provisional
 * running epoch, like the hub's chart. The top-10 share carries no trend
 * chip: a rising share is a worse reading, and the chip's up/down colouring
 * would invert that. Empty without a row.
 */
export function buildGlanceTiles(rows: EpochStatsRow[], circulationLovelace: string | null): GlanceTile[] {
  const current = rows.at(-1) ?? null;
  if (!current) return [];
  const prev = rowBeforeEpoch(rows, current.epoch);
  const tail = contiguousTail(rows);
  const values = recentSeries;
  const voteTail = tail.slice(0, tail.findLastIndex((r) => r.voteDataComplete) + 1);
  const share = circulatingSharePct(current.totalDrepPower, circulationLovelace);
  return [
    {
      label: 'DReps holding delegated power',
      value: formatCount(current.poweredDrepCount),
      icon: 'people',
      trend: trendChip(current.poweredDrepCount, prev?.poweredDrepCount ?? null, formatCount),
      series: values(tail, 'poweredDrepCount'),
      href: hubHref('trends'),
    },
    {
      label: 'Delegated voting power',
      value: formatAdaCompact(current.totalDrepPower) ?? formatAda(current.totalDrepPower),
      icon: 'power',
      trend: trendChip(current.totalDrepPower, prev ? prev.totalDrepPower : null, (n) => formatAdaCompact(n) ?? formatAdaDelta(n)),
      sub: share == null ? undefined : `${share.toFixed(1)}% of circulating ada`,
      series: values(tail, 'totalDrepPower'),
      href: hubHref('today'),
    },
    {
      label: votedLabel(),
      value: formatCount(current.recentlyVotingDrepCount),
      icon: 'gauge',
      alt: true,
      sub: current.voteDataComplete === false ? PROVISIONAL_VOTING_SUB : undefined,
      series: values(voteTail, 'recentlyVotingDrepCount'),
      href: hubHref('activity'),
    },
    {
      label: 'Held by the top 10 DReps',
      value: `${current.top10SharePct.toFixed(1)}%`,
      icon: 'share',
      alt: true,
      sub: 'of delegated voting power',
      ring: current.top10SharePct,
      series: values(tail, 'top10SharePct'),
      href: hubHref('decentralization'),
    },
  ];
}

/**
 * Compact-formatted comparison between the two default-option pools (abstain
 * plus always-no-confidence) and the represented total, for the hub's
 * default-options card. Null unless all three lovelace amounts parse, BigInt
 * throughout since the pools run well past Number's safe-integer range.
 */
export function defaultOptionsComparison(
  abstain: string | null | undefined,
  anc: string | null | undefined,
  reprTotal: string | null,
): { defaultsLabel: string; reprLabel: string } | null {
  if (abstain == null || anc == null || reprTotal == null) return null;
  let defaultsSum: bigint;
  let repr: bigint;
  try {
    defaultsSum = BigInt(abstain) + BigInt(anc);
    repr = BigInt(reprTotal);
  } catch {
    return null;
  }
  const defaultsLabel = formatAdaCompact(defaultsSum.toString());
  const reprLabel = formatAdaCompact(repr.toString());
  if (defaultsLabel == null || reprLabel == null) return null;
  return { defaultsLabel, reprLabel };
}

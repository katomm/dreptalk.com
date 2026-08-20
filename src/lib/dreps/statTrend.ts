// Pure "this epoch" delta math for the DReps directory stat cards. Given the two
// most recent epoch aggregates (newest first), it yields display-ready deltas for
// the active-DRep count, total voting power, and average voting power. No I/O, so
// it is unit-tested in the node pool; the .astro page only renders the result.
import { formatTrendPct } from './votingPowerTrend.js';

export interface StatEpochAggregate {
  epoch: number;
  count: number;
  /** Summed voting power (lovelace); Number is exact enough for the ratios here. */
  total: number;
}

export interface StatTrend {
  direction: 'up' | 'down' | 'flat';
  /** Unsigned display label; the sign is carried by direction and colour. */
  label: string;
}

export interface DrepStatTrends {
  /** Change in the active-DRep count (absolute, e.g. "12"). */
  activeDreps: StatTrend | null;
  /** Change in total voting power (percent, e.g. "8.7%"). */
  totalPower: StatTrend | null;
  /** Change in average voting power per DRep (percent). */
  avgPower: StatTrend | null;
}

function direction(delta: number): 'up' | 'down' | 'flat' {
  return delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
}

/**
 * Relative change of two positive quantities, or null when the base is
 * non-positive. No PCT_DISPLAY_CAP here on purpose: these are sums across every
 * DRep, so the baseline cannot realistically start from dust the way a single
 * freshly registered DRep's can.
 */
function pctTrend(current: number, previous: number): StatTrend | null {
  if (!(previous > 0)) return null;
  const pct = ((current - previous) / previous) * 100;
  return { direction: direction(pct), label: formatTrendPct(pct) };
}

/**
 * Deltas for the three aggregatable cards. Returns all-null when fewer than two
 * epochs have synced (a single epoch has nothing to compare against), so the page
 * simply omits the "this epoch" chips until the history window fills.
 */
export function computeDrepStatTrends(
  current?: StatEpochAggregate,
  previous?: StatEpochAggregate,
): DrepStatTrends {
  if (!current || !previous) {
    return { activeDreps: null, totalPower: null, avgPower: null };
  }
  const countDelta = current.count - previous.count;
  const activeDreps: StatTrend = {
    direction: direction(countDelta),
    label: Math.abs(countDelta).toLocaleString('en-US'),
  };
  const avgCurrent = current.count > 0 ? current.total / current.count : 0;
  const avgPrevious = previous.count > 0 ? previous.total / previous.count : 0;
  return {
    activeDreps,
    totalPower: pctTrend(current.total, previous.total),
    avgPower: pctTrend(avgCurrent, avgPrevious),
  };
}

// The metric contract for governance_epoch_stats: the single source of truth
// for what every column means, where its data comes from, and from which epoch
// its series is reliable. Charts MUST clip to seriesStartFromRows instead of
// assuming history exists, so a NULL never gets rendered as a zero.
//
// Two-layer convention (see src/lib/dreps/special.ts): representative metrics
// exclude the special auto-voting ids, the specials form the default
// delegation layer with their own columns.
import type { EpochStatsRow } from './epochStats.js';

/**
 * How trustworthy the stored values are:
 * - exact: reconstructed from a historical source.
 * - forward-only: values exist only from the first live observation, earlier
 *   epochs are NULL and unrecoverable.
 * - flagged: exact only where the row's vote_data_complete flag is set.
 */
export type MetricReliability = 'exact' | 'forward-only' | 'flagged';

/**
 * Where the metric's reliable series starts. Deliberately independent of
 * reliability: an exact metric can still be nullable (Koios served no row,
 * a fetch was skipped), and its series starts at the first real value, not
 * at the oldest table row.
 */
export type MetricSeriesStart = 'oldest-row' | 'first-non-null' | 'first-complete';

export type MetricSource = 'koios-history' | 'live-observation' | 'local-votes' | 'koios-totals';

export interface EpochStatsMetric {
  /** Column name in governance_epoch_stats, checked against the table by epochStatsContract.workers.test.ts. */
  column: string;
  reliability: MetricReliability;
  start: MetricSeriesStart;
  /** Whether the special auto-voting ids are part of the value. */
  includesSpecials: boolean;
  source: MetricSource;
  /** One-sentence definition, suitable as a chart footnote. */
  definition: string;
}

/**
 * Trailing window for recently_voting_drep_count. Internal knob, one UI
 * variant. Changing this value redefines the stored series: existing rows
 * were computed under the old window, so a change requires resetting
 * vote_data_complete to 0 on stored rows so the repair pass recomputes them.
 */
export const RECENT_VOTING_WINDOW_EPOCHS = 12;

export type EpochStatsMetricKey =
  | 'totalDrepPower'
  | 'poweredDrepCount'
  | 'recentlyVotingDrepCount'
  | 'silentPoweredDrepCount'
  | 'abstainPower'
  | 'ancPower'
  | 'delegatorTotal'
  | 'abstainDelegators'
  | 'ancDelegators'
  | 'gini'
  | 'top10SharePct'
  | 'minCoalition50'
  | 'minCoalition67'
  | 'votesCast'
  | 'treasuryLovelace'
  | 'unexpiredDrepCount'
  | 'unexpiredPoweredDrepCount'
  | 'unexpiredDrepPower'
  | 'unexpiredTop10SharePct';

export const EPOCH_STATS_METRICS: Record<EpochStatsMetricKey, EpochStatsMetric> = {
  totalDrepPower: {
    column: 'total_drep_power',
    reliability: 'exact',
    start: 'oldest-row',
    includesSpecials: false,
    source: 'koios-history',
    definition: 'Summed voting power (lovelace) over every non-special DRep snapshot row for the epoch.',
  },
  poweredDrepCount: {
    column: 'powered_drep_count',
    reliability: 'exact',
    start: 'oldest-row',
    includesSpecials: false,
    source: 'koios-history',
    definition: 'Non-special DRep snapshot rows with voting power above zero this epoch.',
  },
  recentlyVotingDrepCount: {
    column: 'recently_voting_drep_count',
    reliability: 'flagged',
    start: 'first-complete',
    includesSpecials: false,
    source: 'local-votes',
    definition: 'DReps that voted at least once in the last 12 epochs, superseded votes included. Votes without a block time are not counted.',
  },
  silentPoweredDrepCount: {
    column: 'silent_powered_drep_count',
    reliability: 'flagged',
    start: 'first-non-null',
    includesSpecials: false,
    source: 'local-votes',
    definition: 'DReps holding delegated power in the epoch snapshot with no vote in the last 12 epochs, superseded votes included. NULL until the repair pass has read the epoch.',
  },
  abstainPower: {
    column: 'abstain_power',
    reliability: 'exact',
    start: 'first-non-null',
    includesSpecials: true,
    source: 'koios-history',
    definition: 'Voting power (lovelace) delegated to the predefined always-abstain option this epoch.',
  },
  ancPower: {
    column: 'anc_power',
    reliability: 'exact',
    start: 'first-non-null',
    includesSpecials: true,
    source: 'koios-history',
    definition: 'Voting power (lovelace) delegated to the predefined no-confidence option this epoch.',
  },
  delegatorTotal: {
    column: 'delegator_total',
    reliability: 'forward-only',
    start: 'first-non-null',
    includesSpecials: false,
    source: 'live-observation',
    definition: 'Sum of live-observed delegator counts over the epoch snapshot rows, set only when every row carries an observation, never a partial sum.',
  },
  abstainDelegators: {
    column: 'abstain_delegators',
    reliability: 'forward-only',
    start: 'first-non-null',
    includesSpecials: true,
    source: 'live-observation',
    definition: 'Live-observed delegator count of the always-abstain option, recorded from the epoch stamping began.',
  },
  ancDelegators: {
    column: 'anc_delegators',
    reliability: 'forward-only',
    start: 'first-non-null',
    includesSpecials: true,
    source: 'live-observation',
    definition: 'Live-observed delegator count of the no-confidence option, recorded from the epoch stamping began.',
  },
  gini: {
    column: 'gini',
    reliability: 'exact',
    start: 'oldest-row',
    includesSpecials: false,
    source: 'koios-history',
    definition: 'Gini coefficient of voting power across snapshot rows with power above zero, excluding the predefined options.',
  },
  top10SharePct: {
    column: 'top10_share_pct',
    reliability: 'exact',
    start: 'oldest-row',
    includesSpecials: false,
    source: 'koios-history',
    definition: 'Share of the epoch total held by the ten largest non-special DReps, computed from the raw power distribution.',
  },
  minCoalition50: {
    column: 'min_coalition_50',
    reliability: 'exact',
    start: 'oldest-row',
    includesSpecials: false,
    source: 'koios-history',
    definition: 'Fewest DReps whose combined voting power reaches 50% of the epoch total, based on delegated power, not actual coordination.',
  },
  minCoalition67: {
    column: 'min_coalition_67',
    reliability: 'exact',
    start: 'oldest-row',
    includesSpecials: false,
    source: 'koios-history',
    definition: 'Fewest DReps whose combined voting power reaches 67% of the epoch total, based on delegated power, not actual coordination.',
  },
  votesCast: {
    column: 'votes_cast',
    reliability: 'flagged',
    start: 'first-complete',
    includesSpecials: false,
    source: 'local-votes',
    definition: 'DRep votes cast during the epoch, later-superseded votes included. Votes without a block time are not counted.',
  },
  treasuryLovelace: {
    column: 'treasury_lovelace',
    reliability: 'exact',
    start: 'first-non-null',
    includesSpecials: false,
    source: 'koios-totals',
    definition: 'Treasury balance (lovelace) at the epoch.',
  },
  // The four unexpired metrics describe the group behind the header numbers
  // of the DRep list ("Active DReps", "Total voting power"): every row with
  // dreps.active = 1, that is registered DReps whose activity has not expired
  // under the chain's drep_activity rule (Koios drep_info.active). No voting
  // record, name or power floor is part of it. "Unexpired" keeps them apart
  // from recentlyVotingDrepCount, the other meaning of "active". They are the
  // state at the last DRep sync of the epoch, a different instant than the
  // boundary snapshot behind totalDrepPower and poweredDrepCount in the same row.
  unexpiredDrepCount: {
    column: 'unexpired_drep_count',
    reliability: 'forward-only',
    start: 'first-non-null',
    includesSpecials: false,
    source: 'live-observation',
    definition: 'Registered DReps whose activity had not expired at the last DRep sync of the epoch, DReps without voting power included.',
  },
  unexpiredPoweredDrepCount: {
    column: 'unexpired_powered_drep_count',
    reliability: 'forward-only',
    start: 'first-non-null',
    includesSpecials: false,
    source: 'live-observation',
    definition: 'Registered DReps with voting power above zero whose activity had not expired at the last DRep sync of the epoch.',
  },
  unexpiredDrepPower: {
    column: 'unexpired_drep_power',
    reliability: 'forward-only',
    start: 'first-non-null',
    includesSpecials: false,
    source: 'live-observation',
    definition: 'Summed voting power (lovelace) of the registered DReps whose activity had not expired at the last DRep sync of the epoch.',
  },
  unexpiredTop10SharePct: {
    column: 'unexpired_top10_share_pct',
    reliability: 'forward-only',
    start: 'first-non-null',
    includesSpecials: false,
    source: 'live-observation',
    // From the raw amounts, like top10SharePct. The list's "Top 10" card sums
    // per-DRep percents that are already rounded to two decimals, so the two
    // can differ in the last digit. Do not align this one to the card.
    definition: 'Share of the unexpired voting power held by its ten largest DReps at the last DRep sync of the epoch, computed from the raw amounts.',
  },
};

/**
 * First epoch from which the metric's series is reliable, or null when
 * nothing usable is stored yet. Works on the full stats series already in
 * memory (epoch ascending, as listEpochStats returns it), so callers resolve
 * every metric's start without one DB round-trip each. Implements the three
 * start rules of the contract: oldest-row, first-non-null, first-complete.
 *
 * The metric key doubles as the EpochStatsRow field name for every chartable
 * metric (asserted by a test), so no separate name table is needed here, the
 * key indexes the row directly.
 */
export function seriesStartFromRows(
  rows: EpochStatsRow[],
  key: EpochStatsMetricKey,
): number | null {
  if (rows.length === 0) return null;
  const metric = EPOCH_STATS_METRICS[key];
  if (metric.start === 'oldest-row') {
    return rows[0].epoch;
  }
  if (metric.start === 'first-complete') {
    return rows.find((r) => r.voteDataComplete)?.epoch ?? null;
  }
  const field = key as keyof EpochStatsRow;
  return rows.find((r) => r[field] != null)?.epoch ?? null;
}

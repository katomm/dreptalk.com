/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for governance_epoch_stats (the analytics backbone).
// Past epochs are write-once (insertEpochStatsIfMissing), the current epoch is
// recomputed every run (upsertEpochStats), and rows flagged vote-incomplete
// get BOTH vote-derived columns repaired together once the vote-history sweep
// has drained. The special auto-voting ids are excluded from the vote queries
// in the SQL itself, so the contract's includesSpecials: false is guaranteed,
// not assumed from the data model.
import type { EpochStatsRow } from '../analytics/epochStats.js';
import { epochStartUnix, type NetworkConfig } from '../config/network.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';

const COLUMNS =
  'epoch, total_drep_power, powered_drep_count, recently_voting_drep_count, silent_powered_drep_count, ' +
  'abstain_power, anc_power, delegator_total, abstain_delegators, anc_delegators, gini, top10_share_pct, ' +
  'min_coalition_50, min_coalition_67, votes_cast, vote_data_complete, treasury_lovelace, computed_at';
// Every reader projects the same columns minus the bookkeeping timestamp.
const READ_COLUMNS = COLUMNS.split(', ').filter((c) => c !== 'computed_at').join(', ');

const PLACEHOLDERS = COLUMNS.split(', ').map(() => '?').join(', ');

// Everything except the PK, for the conflict update below. treasury_lovelace
// gets its own clause: treasury is constant within an epoch, so if a later
// live-pass write hits an epoch where Koios served an empty array (NULL),
// keeping the earlier intra-epoch value is exact, an overwrite to NULL is not.
const UPDATE_SET = COLUMNS.split(', ')
  .filter((c) => c !== 'epoch')
  .map((c) =>
    c === 'treasury_lovelace' ? `${c} = COALESCE(excluded.${c}, ${c})` : `${c} = excluded.${c}`,
  )
  .join(', ');

const SPECIAL_PLACEHOLDERS = SPECIAL_DREP_IDS.map(() => '?').join(', ');

function binds(row: EpochStatsRow, now: number): unknown[] {
  return [
    row.epoch, row.totalDrepPower, row.poweredDrepCount, row.recentlyVotingDrepCount, row.silentPoweredDrepCount,
    row.abstainPower, row.ancPower, row.delegatorTotal, row.abstainDelegators, row.ancDelegators,
    row.gini, row.top10SharePct, row.minCoalition50, row.minCoalition67,
    row.votesCast, row.voteDataComplete ? 1 : 0, row.treasuryLovelace, now,
  ];
}

/**
 * Writes or updates the epoch's row (current-epoch recompute path). Uses an
 * upsert, not INSERT OR REPLACE: REPLACE is delete + insert in SQLite and
 * would interact badly with any future triggers or foreign keys on this table.
 */
export async function upsertEpochStats(db: D1Database, row: EpochStatsRow, now = Date.now()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO governance_epoch_stats (${COLUMNS}) VALUES (${PLACEHOLDERS})
       ON CONFLICT(epoch) DO UPDATE SET ${UPDATE_SET}`,
    )
    .bind(...binds(row, now))
    .run();
}

/** Backfill path: past epochs are immutable, returns false when the row existed. */
export async function insertEpochStatsIfMissing(db: D1Database, row: EpochStatsRow, now = Date.now()): Promise<boolean> {
  const res = await db
    .prepare(`INSERT OR IGNORE INTO governance_epoch_stats (${COLUMNS}) VALUES (${PLACEHOLDERS})`)
    .bind(...binds(row, now))
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function getStoredStatsEpochs(db: D1Database): Promise<Set<number>> {
  const rows = (
    await db.prepare('SELECT epoch FROM governance_epoch_stats').all<{ epoch: number }>()
  ).results ?? [];
  return new Set(rows.map((r) => r.epoch));
}

/**
 * DRep vote transactions with a block_time inside the epoch, superseded votes
 * (drep_vote_history) included so re-votes count as activity. Specials are
 * excluded in SQL even though they cannot vote on chain, the contract must
 * not depend on that assumption.
 */
export async function countDrepVotesInEpoch(db: D1Database, epoch: number, cfg: NetworkConfig): Promise<number> {
  const from = epochStartUnix(epoch, cfg);
  const to = epochStartUnix(epoch + 1, cfg);
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM drep_votes
           WHERE voter_role = 'DRep' AND block_time >= ? AND block_time < ?
             AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS}))
       + (SELECT COUNT(*) FROM drep_vote_history
           WHERE voter_role = 'DRep' AND block_time >= ? AND block_time < ?
             AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS})) AS n`,
    )
    .bind(from, to, ...SPECIAL_DREP_IDS, from, to, ...SPECIAL_DREP_IDS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Distinct non-special DReps with at least one vote in the trailing
 * `windowEpochs` epochs ending at `epoch` (inclusive). Implements the
 * contract's recently-voting definition, see RECENT_VOTING_WINDOW_EPOCHS.
 * Returns the ids, not just the count: the silent-DRep count needs to
 * intersect them with the epoch's power holders.
 */
export async function listRecentlyVotingDrepIds(
  db: D1Database,
  epoch: number,
  cfg: NetworkConfig,
  windowEpochs: number,
): Promise<Set<string>> {
  const from = epochStartUnix(epoch - windowEpochs + 1, cfg);
  const to = epochStartUnix(epoch + 1, cfg);
  const rows = (
    await db
      .prepare(
        `SELECT voter_id FROM drep_votes
          WHERE voter_role = 'DRep' AND block_time >= ? AND block_time < ?
            AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS})
         UNION
         SELECT voter_id FROM drep_vote_history
          WHERE voter_role = 'DRep' AND block_time >= ? AND block_time < ?
            AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS})`,
      )
      .bind(from, to, ...SPECIAL_DREP_IDS, from, to, ...SPECIAL_DREP_IDS)
      .all<{ voter_id: string }>()
  ).results ?? [];
  return new Set(rows.map((r) => r.voter_id));
}


/** Actions the vote-history sweep has not covered yet (vote_data_complete gate). */
export async function countUnsweptActions(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM governance_actions WHERE vote_history_swept_at IS NULL')
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Epochs whose vote-derived columns still need the repair pass: computed while
 * the sweep was pending, or stored before the silent-DRep column existed.
 */
export async function listIncompleteVoteDataEpochs(db: D1Database): Promise<number[]> {
  const rows = (
    await db
      .prepare(
        'SELECT epoch FROM governance_epoch_stats WHERE vote_data_complete = 0 OR silent_powered_drep_count IS NULL ORDER BY epoch',
      )
      .all<{ epoch: number }>()
  ).results ?? [];
  return rows.map((r) => r.epoch);
}

/**
 * Repairs one epoch's vote-derived columns after the sweep drained. The
 * columns move together with the flag, they share the same source tables.
 * A null silent count keeps the stored value (the caller had no power
 * snapshot to read it against), it never overwrites a real count with NULL.
 */
export async function updateVoteDerivedStats(
  db: D1Database,
  epoch: number,
  votesCast: number,
  recentlyVotingDrepCount: number,
  silentPoweredDrepCount: number | null,
  complete: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE governance_epoch_stats
          SET votes_cast = ?, recently_voting_drep_count = ?,
              silent_powered_drep_count = COALESCE(?, silent_powered_drep_count),
              vote_data_complete = ?
        WHERE epoch = ?`,
    )
    .bind(votesCast, recentlyVotingDrepCount, silentPoweredDrepCount, complete ? 1 : 0, epoch)
    .run();
}

interface RawEpochStatsRow {
  epoch: number;
  total_drep_power: string;
  powered_drep_count: number;
  recently_voting_drep_count: number;
  silent_powered_drep_count: number | null;
  abstain_power: string | null;
  anc_power: string | null;
  delegator_total: number | null;
  abstain_delegators: number | null;
  anc_delegators: number | null;
  gini: number;
  top10_share_pct: number;
  min_coalition_50: number;
  min_coalition_67: number;
  votes_cast: number;
  vote_data_complete: number;
  treasury_lovelace: string | null;
}

function toEpochStatsRow(r: RawEpochStatsRow): EpochStatsRow {
  return {
    epoch: r.epoch,
    totalDrepPower: r.total_drep_power,
    poweredDrepCount: r.powered_drep_count,
    recentlyVotingDrepCount: r.recently_voting_drep_count,
    silentPoweredDrepCount: r.silent_powered_drep_count,
    abstainPower: r.abstain_power,
    ancPower: r.anc_power,
    delegatorTotal: r.delegator_total,
    abstainDelegators: r.abstain_delegators,
    ancDelegators: r.anc_delegators,
    gini: r.gini,
    top10SharePct: r.top10_share_pct,
    minCoalition50: r.min_coalition_50,
    minCoalition67: r.min_coalition_67,
    votesCast: r.votes_cast,
    voteDataComplete: r.vote_data_complete === 1,
    treasuryLovelace: r.treasury_lovelace,
  };
}

/**
 * Single-epoch backbone read, for callers that need one epoch's row (for
 * example mapping a governance action to its epoch's total_drep_power) without
 * pulling the whole series. Null when the epoch has no stored row yet.
 */
export async function getEpochStatsByEpoch(db: D1Database, epoch: number): Promise<EpochStatsRow | null> {
  const row = await db
    .prepare(
      `SELECT ${READ_COLUMNS}
         FROM governance_epoch_stats WHERE epoch = ?`,
    )
    .bind(epoch)
    .first<RawEpochStatsRow>();
  return row ? toEpochStatsRow(row) : null;
}

/**
 * The newest `limit` rows in ascending epoch order, for the homepage strip,
 * which needs a short trailing window (current epoch, its predecessor and a
 * sparkline's worth of history) and must not pay for the whole table on every
 * request. Callers still pair rows with rowBeforeEpoch and contiguousTail:
 * mid-backfill the older rows can be ancient epochs.
 */
export async function listLatestEpochStats(db: D1Database, limit: number): Promise<EpochStatsRow[]> {
  const rows = (
    await db
      .prepare(`SELECT ${READ_COLUMNS} FROM governance_epoch_stats ORDER BY epoch DESC LIMIT ?`)
      .bind(limit)
      .all<RawEpochStatsRow>()
  ).results ?? [];
  return rows.map(toEpochStatsRow).reverse();
}

/**
 * The stored stats series, epoch ascending, for the analytics hub. Callers
 * clip each metric to its seriesStartEpoch before charting, this read is
 * deliberately raw. The whole table is ~150 rows per network.
 */
export async function listEpochStats(
  db: D1Database,
  opts: { fromEpoch?: number } = {},
): Promise<EpochStatsRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT ${READ_COLUMNS}
           FROM governance_epoch_stats WHERE epoch >= ? ORDER BY epoch ASC`,
      )
      .bind(opts.fromEpoch ?? 0)
      .all<RawEpochStatsRow>()
  ).results ?? [];
  return rows.map(toEpochStatsRow);
}

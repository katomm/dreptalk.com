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
  'epoch, total_drep_power, powered_drep_count, recently_voting_drep_count, abstain_power, anc_power, ' +
  'delegator_total, abstain_delegators, anc_delegators, gini, top10_share_pct, min_coalition_50, ' +
  'min_coalition_67, votes_cast, vote_data_complete, treasury_lovelace, computed_at';

const PLACEHOLDERS = Array.from({ length: 17 }, () => '?').join(', ');

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
    row.epoch, row.totalDrepPower, row.poweredDrepCount, row.recentlyVotingDrepCount,
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
 */
export async function countRecentlyVotingDreps(
  db: D1Database,
  epoch: number,
  cfg: NetworkConfig,
  windowEpochs: number,
): Promise<number> {
  const from = epochStartUnix(epoch - windowEpochs + 1, cfg);
  const to = epochStartUnix(epoch + 1, cfg);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT voter_id FROM drep_votes
          WHERE voter_role = 'DRep' AND block_time >= ? AND block_time < ?
            AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS})
         UNION
         SELECT voter_id FROM drep_vote_history
          WHERE voter_role = 'DRep' AND block_time >= ? AND block_time < ?
            AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS})
       )`,
    )
    .bind(from, to, ...SPECIAL_DREP_IDS, from, to, ...SPECIAL_DREP_IDS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Actions the vote-history sweep has not covered yet (vote_data_complete gate). */
export async function countUnsweptActions(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM governance_actions WHERE vote_history_swept_at IS NULL')
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Epochs whose vote-derived columns were computed while the sweep was pending. */
export async function listIncompleteVoteDataEpochs(db: D1Database): Promise<number[]> {
  const rows = (
    await db
      .prepare('SELECT epoch FROM governance_epoch_stats WHERE vote_data_complete = 0 ORDER BY epoch')
      .all<{ epoch: number }>()
  ).results ?? [];
  return rows.map((r) => r.epoch);
}

/**
 * Repairs one epoch's vote-derived columns after the sweep drained. Both
 * columns move together with the flag, they share the same source tables.
 */
export async function updateVoteDerivedStats(
  db: D1Database,
  epoch: number,
  votesCast: number,
  recentlyVotingDrepCount: number,
  complete: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE governance_epoch_stats
          SET votes_cast = ?, recently_voting_drep_count = ?, vote_data_complete = ?
        WHERE epoch = ?`,
    )
    .bind(votesCast, recentlyVotingDrepCount, complete ? 1 : 0, epoch)
    .run();
}

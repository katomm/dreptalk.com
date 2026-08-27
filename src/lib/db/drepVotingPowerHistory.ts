/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for drep_voting_power_history: per-epoch voting power
// snapshots that feed the directory list delta chip and the profile sparkline.
// All writes use .prepare().bind(); never string-concatenated values.
import { SPECIAL_DREP_IDS } from '../dreps/special.js';

export interface VotingPowerHistoryRow {
  drepId: string;
  epoch: number;
  amount: string;
}

/**
 * One point of a DRep's trend: the epoch snapshot plus the delegator headcount
 * observed during that epoch. The count is NULL for every epoch captured before
 * the stamp existed (and for a DRep Koios reported no count for), so consumers
 * must treat the count series as shorter than the amount series.
 */
export interface DrepVotingPowerSeriesPoint {
  epoch: number;
  amount: string;
  delegatorCount: number | null;
}

export interface VotingPowerEpochAggregate {
  epoch: number;
  /** DReps with a snapshot this epoch (special auto-voting ids excluded). */
  count: number;
  /**
   * Summed voting power in lovelace, as a JS number. Network totals reach ~2e16
   * lovelace, past Number's exact-integer range, so this is only precise enough
   * for epoch-over-epoch ratios; never treat it as an exact lovelace amount.
   */
  total: number;
}

/**
 * The two most recent epochs' aggregate DRep voting power, newest first, for the
 * directory stat cards' "this epoch" deltas. One grouped scan of the rolling
 * history window; the special auto-voting DReps are excluded so the totals line
 * up with the concentration figures. Returns 0, 1, or 2 rows depending on how
 * many epochs have synced.
 */
export async function getVotingPowerEpochAggregates(
  db: D1Database,
): Promise<VotingPowerEpochAggregate[]> {
  const placeholders = SPECIAL_DREP_IDS.map(() => '?').join(', ');
  const rows = (
    await db
      .prepare(
        `SELECT epoch, COUNT(*) AS count, SUM(CAST(amount AS INTEGER)) AS total
         FROM drep_voting_power_history
         WHERE drep_id NOT IN (${placeholders})
         GROUP BY epoch
         ORDER BY epoch DESC
         LIMIT 2`,
      )
      .bind(...SPECIAL_DREP_IDS)
      .all<{ epoch: number; count: number; total: number | null }>()
  ).results ?? [];
  return rows.map((r) => ({ epoch: r.epoch, count: r.count, total: Number(r.total ?? 0) }));
}

// D1 caps bound parameters per query at 100 (not SQLite's higher native limit;
// the local Miniflare test runtime does not enforce it, so this must be sized for
// the real database). Three binds per row, so 33 rows per multi-row INSERT stays
// at 99 parameters, just under the cap.
const INSERT_CHUNK = 33;

/** The distinct epochs already captured, so a sync only fetches the missing ones. */
export async function getStoredEpochs(db: D1Database): Promise<Set<number>> {
  const rows = (
    await db.prepare('SELECT DISTINCT epoch FROM drep_voting_power_history').all<{ epoch: number }>()
  ).results ?? [];
  return new Set(rows.map((r) => r.epoch));
}

/**
 * Inserts snapshot rows, ignoring any (drep_id, epoch) already present: an epoch
 * snapshot is immutable once captured, so re-running a sync never rewrites it.
 * Batched into multi-row INSERTs to respect the SQLite bound-parameter cap.
 * Returns the number of rows supplied. No-op on empty input.
 */
export async function insertVotingPowerHistory(
  db: D1Database,
  rows: VotingPowerHistoryRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => '(?, ?, ?)').join(', ');
    const binds = chunk.flatMap((r) => [r.drepId, r.epoch, r.amount]);
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO drep_voting_power_history (drep_id, epoch, amount) VALUES ${values}`,
        )
        .bind(...binds),
    );
  }
  await db.batch(stmts);
  return rows.length;
}

/** Deletes snapshots older than minEpoch (rolling-window prune). Returns the deleted count. */
export async function pruneVotingPowerHistoryBefore(db: D1Database, minEpoch: number): Promise<number> {
  const res = await db
    .prepare('DELETE FROM drep_voting_power_history WHERE epoch < ?')
    .bind(minEpoch)
    .run();
  return res.meta.changes ?? 0;
}

/** One DRep's snapshots, oldest epoch first, for the profile sparkline. */
export async function getDrepVotingPowerSeries(
  db: D1Database,
  drepId: string,
): Promise<DrepVotingPowerSeriesPoint[]> {
  const rows = (
    await db
      .prepare(
        `SELECT epoch, amount, delegator_count FROM drep_voting_power_history
          WHERE drep_id = ? ORDER BY epoch ASC`,
      )
      .bind(drepId)
      .all<{ epoch: number; amount: string; delegator_count: number | null }>()
  ).results ?? [];
  return rows.map((r) => ({
    epoch: r.epoch,
    amount: r.amount,
    delegatorCount: r.delegator_count,
  }));
}

/**
 * Projects the latest two epoch snapshots (currentEpoch and currentEpoch-1) onto
 * every dreps row in one set-based UPDATE, so the directory list renders the delta
 * without joining the history table. A DRep absent from an epoch gets NULL on that
 * side; a NULL prev means the row shows no delta chip.
 */
export async function denormalizeDrepVotingPower(db: D1Database, currentEpoch: number): Promise<void> {
  await db
    .prepare(
      `UPDATE dreps SET
         voting_power_snapshot = (
           SELECT amount FROM drep_voting_power_history h
           WHERE h.drep_id = dreps.drep_id AND h.epoch = ?1
         ),
         voting_power_prev = (
           SELECT amount FROM drep_voting_power_history h
           WHERE h.drep_id = dreps.drep_id AND h.epoch = ?2
         ),
         voting_power_snapshot_epoch = ?1`,
    )
    .bind(currentEpoch, currentEpoch - 1)
    .run();
}

// Two binds per (drep_id, count) pair plus the epoch bind, so 49 pairs keep a
// statement at 99 parameters, under D1's 100-bind cap.
const STAMP_CHUNK = 49;

/**
 * Stamps delegator counts observed by THIS sync run into the given epoch's
 * rows, stamp-once: only rows still NULL are written, so the first successful
 * pass of an epoch freezes each DRep's value and later passes retry only the
 * gaps, each with its own fresh observation. Deliberately takes the observed
 * map instead of reading dreps.delegator_count, which can silently hold a
 * stale value when Koios omitted the count (see sync.ts buildRow). Rows
 * without an observation stay NULL. Returns the number of rows stamped.
 */
export async function stampDelegatorCounts(
  db: D1Database,
  epoch: number,
  observed: ReadonlyMap<string, number>,
): Promise<number> {
  if (observed.size === 0) return 0;
  // Cheap pre-scan: after the first successful pass of an epoch this is empty
  // and the stamp costs one indexed SELECT (idx_drep_voting_power_history_epoch).
  const open =
    (
      await db
        .prepare(
          'SELECT drep_id FROM drep_voting_power_history WHERE epoch = ? AND delegator_count IS NULL',
        )
        .bind(epoch)
        .all<{ drep_id: string }>()
    ).results ?? [];
  const pairs: [string, number][] = [];
  for (const row of open) {
    const count = observed.get(row.drep_id);
    if (count != null) pairs.push([row.drep_id, count]);
  }
  if (pairs.length === 0) return 0;

  // UPDATE ... FROM (VALUES ...) needs SQLite 3.33+, which both workerd and D1
  // ship. SQLite names bare VALUES columns column1/column2. Should a future
  // runtime reject the syntax (the workers tests would fail immediately), fall
  // back to one UPDATE per pair batched through db.batch.
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < pairs.length; i += STAMP_CHUNK) {
    const chunk = pairs.slice(i, i + STAMP_CHUNK);
    const values = chunk.map(() => '(?, ?)').join(', ');
    stmts.push(
      db
        .prepare(
          `UPDATE drep_voting_power_history AS h
              SET delegator_count = v.column2
             FROM (VALUES ${values}) AS v
            WHERE h.drep_id = v.column1 AND h.epoch = ? AND h.delegator_count IS NULL`,
        )
        .bind(...chunk.flat(), epoch),
    );
  }
  const results = await db.batch(stmts);
  return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

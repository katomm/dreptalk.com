/// <reference types="@cloudflare/workers-types" />
// Orchestration for the governance_epoch_stats phases. The current-epoch pass
// reads the already-synced drep_voting_power_history window (specials are in
// it) and recomputes its row every run, so intra-epoch votes and late
// delegator stamps converge. Its row always carries vote_data_complete = 0,
// an open epoch's vote set is incomplete by definition, no matter how the
// sweep looks at compute time. The backfill's repair pass finalizes the row
// (both vote-derived columns and the flag) once the epoch has closed and the
// vote-history sweep has drained. The backfill also fetches older epochs from
// Koios transiently (never into the history table), oldest first, budgeted
// per run, and leaves the forward-only delegator columns NULL. See
// epochStatsContract.ts for what every column means.
import { computeEpochStatsRow, countSilentPoweredDreps, type EpochHistoryInput } from './epochStats.js';
import { RECENT_VOTING_WINDOW_EPOCHS } from './epochStatsContract.js';
import {
  upsertEpochStats,
  insertEpochStatsIfMissing,
  getStoredStatsEpochs,
  countDrepVotesInEpoch,
  listRecentlyVotingDrepIds,
  countUnsweptActions,
  listIncompleteVoteDataEpochs,
  updateVoteDerivedStats,
} from '../db/governanceEpochStats.js';
import { fetchEpochPowerRows } from '../dreps/votingPowerHistorySync.js';
import type { NetworkConfig } from '../config/network.js';

export interface EpochStatsKoios {
  totals(epochNo?: number): Promise<{ treasuryLovelace: string } | null>;
  firstDrepPowerEpoch(): Promise<number | null>;
  drepVotingPowerHistory(
    epochNo: number,
    limit?: number,
    offset?: number,
  ): Promise<{ drep_id: string; epoch_no: number; amount: string | null }[]>;
}

async function loadStoredEpochHistory(db: D1Database, epoch: number): Promise<EpochHistoryInput[]> {
  const rows = (
    await db
      .prepare('SELECT drep_id, amount, delegator_count FROM drep_voting_power_history WHERE epoch = ?')
      .bind(epoch)
      .all<{ drep_id: string; amount: string; delegator_count: number | null }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id, amount: r.amount, delegatorCount: r.delegator_count }));
}

/**
 * `epochClosed` decides whether vote_data_complete can ever be true: an open
 * epoch's vote set is incomplete by definition (the cron still has hours left
 * to observe votes in it), so the live pass always passes false regardless of
 * sweep state. The backfill passes true, since a backfilled epoch has already
 * closed, and the sweep-based gate (unswept === 0) is the right check there.
 */
async function buildRow(
  db: D1Database,
  cfg: NetworkConfig,
  epoch: number,
  history: EpochHistoryInput[],
  treasuryLovelace: string | null,
  epochClosed: boolean,
) {
  const [unswept, recentlyVotingDrepIds, votesCast] = await Promise.all([
    countUnsweptActions(db),
    listRecentlyVotingDrepIds(db, epoch, cfg, RECENT_VOTING_WINDOW_EPOCHS),
    countDrepVotesInEpoch(db, epoch, cfg),
  ]);
  return computeEpochStatsRow({
    epoch,
    history,
    recentlyVotingDrepIds,
    votesCast,
    voteDataComplete: epochClosed && unswept === 0,
    treasuryLovelace,
  });
}

export interface SyncCurrentEpochStatsDeps {
  db: D1Database;
  koios: EpochStatsKoios;
  cfg: NetworkConfig;
  /** The epoch the history phase captured this run. */
  epoch: number;
}

export async function syncCurrentEpochStats(deps: SyncCurrentEpochStatsDeps): Promise<{ written: boolean }> {
  const history = await loadStoredEpochHistory(deps.db, deps.epoch);
  if (history.length === 0) return { written: false };
  const treasury = (await deps.koios.totals(deps.epoch))?.treasuryLovelace ?? null;
  const row = await buildRow(deps.db, deps.cfg, deps.epoch, history, treasury, false);
  await upsertEpochStats(deps.db, row);
  return { written: true };
}

export interface BackfillEpochStatsDeps {
  db: D1Database;
  koios: EpochStatsKoios;
  cfg: NetworkConfig;
  currentEpoch: number;
  /**
   * Koios snapshot fetches per run, keeps the drain bounded per cron
   * invocation. Shared by the repair pass (a row that predates the silent
   * column and has left the stored history window) and the insert backfill.
   */
  budget: number;
}

// Post-fix-1 this list normally holds exactly one epoch, the one that just
// closed, since the live pass never lets an open epoch's flag go true and
// the repair pass runs every backfill invocation. The cap only guards the
// pathological case where the sweep stayed behind for a long stretch and
// many epochs piled up incomplete, so one run cannot be made to walk an
// unbounded backlog. Rows stored before the silent-DRep column existed are
// in the same list until that column is filled.
const MAX_REPAIRS_PER_RUN = 24;

/**
 * Powered DReps of the epoch with no vote in the window, or null when no
 * power snapshot is at hand to read the count against. The snapshot comes
 * from the stored history window where the epoch is still in it, and from a
 * transient Koios fetch otherwise, one fetch per epoch counted against the
 * run's budget. The silent count is the only vote-derived column that needs
 * the snapshot, so a missing one leaves the other repairs untouched.
 */
async function silentCount(
  deps: BackfillEpochStatsDeps,
  epoch: number,
  stored: EpochHistoryInput[],
  voters: ReadonlySet<string>,
  fetchBudget: { left: number },
): Promise<number | null> {
  let history = stored;
  if (history.length === 0 && fetchBudget.left > 0) {
    fetchBudget.left -= 1;
    history = (await fetchEpochPowerRows(deps.koios, epoch)).map((r) => ({ drepId: r.drepId, amount: r.amount }));
  }
  if (history.length === 0) return null;
  return countSilentPoweredDreps(history, voters);
}

export async function backfillEpochStats(
  deps: BackfillEpochStatsDeps,
): Promise<{ inserted: number; repaired: number; remaining: number }> {
  // Repair pass first: rows whose vote-derived columns were computed while
  // the epoch was still open or the sweep was pending get the columns
  // recomputed together once the epoch has closed and nothing is unswept
  // anymore. Local SQL, plus a Koios snapshot fetch only for a row that
  // predates the silent-DRep column and has left the stored history window.
  // The current epoch is skipped, the live pass owns and recomputes it anyway.
  const fetchBudget = { left: deps.budget };
  let repaired = 0;
  if ((await countUnsweptActions(deps.db)) === 0) {
    const incomplete = (await listIncompleteVoteDataEpochs(deps.db)).filter((epoch) => epoch < deps.currentEpoch);
    for (const epoch of incomplete.slice(0, MAX_REPAIRS_PER_RUN)) {
      const [votes, voters, stored] = await Promise.all([
        countDrepVotesInEpoch(deps.db, epoch, deps.cfg),
        listRecentlyVotingDrepIds(deps.db, epoch, deps.cfg, RECENT_VOTING_WINDOW_EPOCHS),
        loadStoredEpochHistory(deps.db, epoch),
      ]);
      const silent = await silentCount(deps, epoch, stored, voters, fetchBudget);
      await updateVoteDerivedStats(deps.db, epoch, votes, voters.size, silent, true);
      repaired++;
    }
  }

  const floor = await deps.koios.firstDrepPowerEpoch();
  if (floor == null || floor >= deps.currentEpoch) return { inserted: 0, repaired, remaining: 0 };

  const stored = await getStoredStatsEpochs(deps.db);
  const missing: number[] = [];
  for (let e = floor; e < deps.currentEpoch; e++) if (!stored.has(e)) missing.push(e);

  let inserted = 0;
  for (const epoch of missing.slice(0, fetchBudget.left)) {
    // Both fetches are required: a totals fetch that throws, or comes back
    // null (Koios served nothing for the epoch), leaves the epoch missing for
    // the next run instead of writing a write-once row with a NULL treasury
    // column and no repair path (atomic completeness).
    const rows = await fetchEpochPowerRows(deps.koios, epoch);
    if (rows.length === 0) continue; // Koios served nothing, stays in remaining
    const totalsRow = await deps.koios.totals(epoch);
    if (totalsRow == null) continue; // atomic completeness, epoch stays in remaining
    const history: EpochHistoryInput[] = rows.map((r) => ({ drepId: r.drepId, amount: r.amount }));
    const row = await buildRow(deps.db, deps.cfg, epoch, history, totalsRow.treasuryLovelace, true);
    if (await insertEpochStatsIfMissing(deps.db, row)) inserted++;
  }
  // Everything not inserted this run is still missing, including epochs the
  // budget never reached and epochs whose fetch came back empty.
  const remaining = missing.length - inserted;
  return { inserted, repaired, remaining };
}

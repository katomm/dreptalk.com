/// <reference types="@cloudflare/workers-types" />
// Orchestration for the governance_epoch_stats phases. The current-epoch pass
// reads the already-synced drep_voting_power_history window (specials are in
// it) and recomputes its row every run, so intra-epoch votes and late
// delegator stamps converge. The backfill fetches older epochs from Koios
// transiently (never into the history table), oldest first, budgeted per run,
// and leaves the forward-only delegator columns NULL. See
// epochStatsContract.ts for what every column means.
import { computeEpochStatsRow, type EpochHistoryInput } from './epochStats.js';
import { RECENT_VOTING_WINDOW_EPOCHS } from './epochStatsContract.js';
import {
  upsertEpochStats,
  insertEpochStatsIfMissing,
  getStoredStatsEpochs,
  countDrepVotesInEpoch,
  countRecentlyVotingDreps,
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

async function buildRow(
  db: D1Database,
  cfg: NetworkConfig,
  epoch: number,
  history: EpochHistoryInput[],
  treasuryLovelace: string | null,
) {
  const unswept = await countUnsweptActions(db);
  return computeEpochStatsRow({
    epoch,
    history,
    recentlyVotingDrepCount: await countRecentlyVotingDreps(db, epoch, cfg, RECENT_VOTING_WINDOW_EPOCHS),
    votesCast: await countDrepVotesInEpoch(db, epoch, cfg),
    voteDataComplete: unswept === 0,
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
  const row = await buildRow(deps.db, deps.cfg, deps.epoch, history, treasury);
  await upsertEpochStats(deps.db, row);
  return { written: true };
}

export interface BackfillEpochStatsDeps {
  db: D1Database;
  koios: EpochStatsKoios;
  cfg: NetworkConfig;
  currentEpoch: number;
  /** Epochs fetched per run, keeps the drain bounded per cron invocation. */
  budget: number;
}

export async function backfillEpochStats(
  deps: BackfillEpochStatsDeps,
): Promise<{ inserted: number; repaired: number; remaining: number }> {
  // Repair pass first: rows whose vote-derived columns were computed while
  // the sweep was pending get both columns recomputed together once nothing
  // is unswept anymore. Pure local SQL. The current epoch is skipped, the
  // live pass owns and recomputes it anyway.
  let repaired = 0;
  if ((await countUnsweptActions(deps.db)) === 0) {
    for (const epoch of await listIncompleteVoteDataEpochs(deps.db)) {
      if (epoch >= deps.currentEpoch) continue;
      const votes = await countDrepVotesInEpoch(deps.db, epoch, deps.cfg);
      const recent = await countRecentlyVotingDreps(deps.db, epoch, deps.cfg, RECENT_VOTING_WINDOW_EPOCHS);
      await updateVoteDerivedStats(deps.db, epoch, votes, recent, true);
      repaired++;
    }
  }

  const floor = await deps.koios.firstDrepPowerEpoch();
  if (floor == null || floor >= deps.currentEpoch) return { inserted: 0, repaired, remaining: 0 };

  const stored = await getStoredStatsEpochs(deps.db);
  const missing: number[] = [];
  for (let e = floor; e < deps.currentEpoch; e++) if (!stored.has(e)) missing.push(e);

  let inserted = 0;
  for (const epoch of missing.slice(0, deps.budget)) {
    // Both fetches are required: a totals fetch that throws, or comes back
    // null (Koios served nothing for the epoch), leaves the epoch missing for
    // the next run instead of writing a write-once row with a NULL treasury
    // column and no repair path (atomic completeness).
    const rows = await fetchEpochPowerRows(deps.koios, epoch);
    if (rows.length === 0) continue; // Koios served nothing, stays in remaining
    const totalsRow = await deps.koios.totals(epoch);
    if (totalsRow == null) continue; // atomic completeness, epoch stays in remaining
    const history: EpochHistoryInput[] = rows.map((r) => ({ drepId: r.drepId, amount: r.amount }));
    const row = await buildRow(deps.db, deps.cfg, epoch, history, totalsRow.treasuryLovelace);
    if (await insertEpochStatsIfMissing(deps.db, row)) inserted++;
  }
  // Everything not inserted this run is still missing, including epochs the
  // budget never reached and epochs whose fetch came back empty.
  const remaining = missing.length - inserted;
  return { inserted, repaired, remaining };
}

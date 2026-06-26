// Self-healing sync of per-epoch DRep voting power snapshots. Each run ensures
// the last `windowSize` epochs are present in drep_voting_power_history, fetching
// ONLY the epochs not yet stored (Koios serves any epoch historically, so the
// previous-epoch data needs no waiting). It then prunes anything older than the
// window and projects the latest two snapshots onto the dreps rows for the list
// delta chip. LEAN: a cold run fetches the whole window once; steady state fetches
// just the new epoch when it rolls (~every 5 days).

import type { DrepVotingPowerHistoryRow } from '../koios/client.js';
import {
  getStoredEpochs,
  insertVotingPowerHistory,
  pruneVotingPowerHistoryBefore,
  denormalizeDrepVotingPower,
  type VotingPowerHistoryRow,
} from '../db/drepVotingPowerHistory.js';

// Koios paginates /drep_voting_power_history at 1000 rows; page through by
// incrementing offset until a short page signals the end.
const PAGE_SIZE = 1000;
// Default rolling window: eight epochs (~40 days) of trend for the profile sparkline.
const DEFAULT_WINDOW = 8;

export interface VotingPowerHistorySyncDeps {
  koios: {
    drepVotingPowerHistory(
      epochNo: number,
      limit?: number,
      offset?: number,
    ): Promise<DrepVotingPowerHistoryRow[]>;
  };
  db: D1Database;
  /** The current chain epoch (tip). The window ends here. */
  currentEpoch: number;
  /** How many trailing epochs to retain. Defaults to DEFAULT_WINDOW. */
  windowSize?: number;
}

export interface VotingPowerHistorySyncResult {
  /** The epochs the window targets (oldest first). */
  window: number[];
  /** Epochs actually fetched this run (the ones that were missing). */
  fetchedEpochs: number[];
  /** Snapshot rows inserted this run. */
  inserted: number;
  /** Snapshot rows pruned below the window floor. */
  pruned: number;
}

/** Pages through one epoch, collecting every DRep's snapshot (skipping null amounts). */
async function fetchEpoch(
  koios: VotingPowerHistorySyncDeps['koios'],
  epoch: number,
): Promise<VotingPowerHistoryRow[]> {
  const out: VotingPowerHistoryRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await koios.drepVotingPowerHistory(epoch, PAGE_SIZE, offset);
    for (const row of page) {
      if (row.amount != null) out.push({ drepId: row.drep_id, epoch, amount: row.amount });
    }
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

export async function syncDrepVotingPowerHistory(
  deps: VotingPowerHistorySyncDeps,
): Promise<VotingPowerHistorySyncResult> {
  const { koios, db, currentEpoch } = deps;
  const windowSize = deps.windowSize ?? DEFAULT_WINDOW;
  const floor = Math.max(0, currentEpoch - windowSize + 1);
  const window = Array.from({ length: currentEpoch - floor + 1 }, (_, i) => floor + i);

  const stored = await getStoredEpochs(db);
  const missing = window.filter((e) => !stored.has(e));

  let inserted = 0;
  const fetchedEpochs: number[] = [];
  for (const epoch of missing) {
    const rows = await fetchEpoch(koios, epoch);
    inserted += await insertVotingPowerHistory(db, rows);
    fetchedEpochs.push(epoch);
  }

  const pruned = await pruneVotingPowerHistoryBefore(db, floor);
  // Re-project onto the dreps rows only when a new epoch landed: the denormalized
  // snapshots are immutable once set, so an intra-epoch run (nothing fetched) would
  // rewrite ~2000 rows for no change. The cold backfill always fetches, so the
  // first run still populates every row.
  if (fetchedEpochs.length > 0) await denormalizeDrepVotingPower(db, currentEpoch);

  return { window, fetchedEpochs, inserted, pruned };
}

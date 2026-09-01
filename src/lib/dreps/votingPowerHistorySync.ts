// Self-healing sync of per-epoch DRep voting power snapshots. Each run ensures
// every epoch back to the retention floor is present in drep_voting_power_history,
// fetching ONLY the epochs not yet stored (Koios serves any epoch historically, so
// the previous-epoch data needs no waiting). The floor is normally an absolute
// epoch (floorEpoch, the network's first DRep power epoch), retaining the full
// Conway history, the relative window is only the legacy fallback for when that
// absolute floor is unavailable. A cold run's missing set can span hundreds of
// epochs, so a per-run fetch budget caps the subrequest count and the backlog
// drips over subsequent cron runs. Missing epochs are fetched newest first, since
// the list delta chip and the sparkline head depend on the newest epochs, so those
// heal before older history catches up. Pruning runs only when the caller supplies
// an absolute floorEpoch, since deleting against the unconfirmed relative window
// could remove rows that an earlier run correctly backfilled after a Koios flake.
// It then prunes anything older than the floor and projects the latest two
// snapshots onto the dreps rows for the list delta chip.

import type { DrepVotingPowerHistoryRow } from '../koios/client.js';
import {
  getStoredEpochs,
  insertVotingPowerHistory,
  pruneVotingPowerHistoryBefore,
  denormalizeDrepVotingPower,
  stampDelegatorCounts,
  type VotingPowerHistoryRow,
} from '../db/drepVotingPowerHistory.js';

// Koios paginates /drep_voting_power_history at 1000 rows; page through by
// incrementing offset until a short page signals the end.
const PAGE_SIZE = 1000;
// Default rolling window: sixteen epochs (~80 days) of trend for the profile
// sparkline. Raising it is self-healing: the next run fetches the newly missing
// older epochs from Koios (served historically), no manual backfill needed.
// Legacy fallback only, used when no absolute floorEpoch is supplied.
const DEFAULT_WINDOW = 16;
// Epochs fetched from Koios per run. A cold full-history backfill can be hundreds
// of epochs on mainnet, so this budget keeps one run's subrequest count small and
// lets the self-healing missing-epoch scan drain the rest over later runs.
const DEFAULT_MAX_FETCH_PER_RUN = 12;

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
  /**
   * How many trailing epochs to retain. Defaults to DEFAULT_WINDOW. Ignored
   * whenever floorEpoch resolves to an absolute floor.
   */
  windowSize?: number;
  /**
   * Absolute retention floor (the network's first DRep power epoch). When set
   * and not after currentEpoch, this overrides the relative window and extends
   * retention back to the full Conway history instead of a rolling window.
   * Null (or omitted) falls back to the relative windowSize.
   */
  floorEpoch?: number | null;
  /**
   * Epochs fetched from Koios per run. Defaults to DEFAULT_MAX_FETCH_PER_RUN,
   * keeping a cold full-history backfill from flooding one run.
   */
  maxFetchPerRun?: number;
  /**
   * Delegator counts observed by the dreps phase of THIS run (see
   * DrepSyncResult.observedDelegatorCounts). Optional: without it the stamp
   * is skipped and the epoch's counts stay NULL until a later pass supplies
   * observations.
   */
  observedDelegatorCounts?: ReadonlyMap<string, number>;
}

export interface VotingPowerHistorySyncResult {
  /** The epochs the retention floor targets (oldest first). */
  window: number[];
  /** Epochs actually fetched this run, newest first (the missing ones within budget). */
  fetchedEpochs: number[];
  /** Snapshot rows inserted this run. */
  inserted: number;
  /** Snapshot rows pruned below the retention floor. */
  pruned: number;
  /** Missing epochs the fetch budget did not reach this run, left for a later run. */
  remaining: number;
  /** Current-epoch rows whose delegator count was stamped this run. */
  stamped: number;
}

/** Pages through one epoch, collecting every DRep's snapshot (skipping null amounts). */
export async function fetchEpochPowerRows(
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
  const budget = deps.maxFetchPerRun ?? DEFAULT_MAX_FETCH_PER_RUN;
  // Null unless the caller supplied a usable absolute floor, in which case it
  // both extends retention and is the only floor pruning is allowed to use.
  const absoluteFloor =
    deps.floorEpoch != null && deps.floorEpoch <= currentEpoch ? deps.floorEpoch : null;
  const floor = absoluteFloor ?? Math.max(0, currentEpoch - windowSize + 1);
  const window = Array.from({ length: currentEpoch - floor + 1 }, (_, i) => floor + i);

  const stored = await getStoredEpochs(db);
  // Newest first: the delta chip and the sparkline head depend on the newest
  // epochs, so those heal before older history within the same budget.
  const missing = window.filter((e) => !stored.has(e)).sort((a, b) => b - a);
  const toFetch = missing.slice(0, budget);

  let inserted = 0;
  const fetchedEpochs: number[] = [];
  for (const epoch of toFetch) {
    const rows = await fetchEpochPowerRows(koios, epoch);
    inserted += await insertVotingPowerHistory(db, rows);
    fetchedEpochs.push(epoch);
  }

  // Only an absolute floor is a confirmed retention boundary: a run stuck on the
  // relative window (legacy caller, or the phase's .catch(() => null) fallback
  // after a Koios flake) must never delete rows an earlier run backfilled.
  const pruned = absoluteFloor !== null ? await pruneVotingPowerHistoryBefore(db, absoluteFloor) : 0;
  // Re-project onto the dreps rows only when a recent epoch actually landed: a
  // backfill drip fetches only old epochs and would otherwise rewrite ~2000 rows
  // for no change to the current snapshot. The cold backfill always includes the
  // current epoch, so the first run still populates every row.
  if (fetchedEpochs.some((e) => e >= currentEpoch - 1)) await denormalizeDrepVotingPower(db, currentEpoch);

  // Freeze this run's observed delegator counts into the current epoch's rows
  // (stamp-once inside, see stampDelegatorCounts).
  const stamped = await stampDelegatorCounts(
    db,
    currentEpoch,
    deps.observedDelegatorCounts ?? new Map(),
  );

  return { window, fetchedEpochs, inserted, pruned, remaining: missing.length - toFetch.length, stamped };
}

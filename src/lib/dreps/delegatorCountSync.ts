// Self-healing delegator-count sync. Koios has no bulk delegator endpoint, so each
// run refreshes the N stalest DReps one cheap count request each (see
// koios.drepDelegatorCount). Never-counted DReps come first, so a cold start fills
// the whole set within a few runs, and steady state keeps every count trickling
// forward. A per-DRep fetch failure is counted and skipped; the successful counts
// are still written. Only the two count columns change, so the profile sync and its
// FTS triggers are untouched.

import { listDrepsForDelegatorCountRefresh, updateDrepDelegatorCounts } from '../db/dreps.js';

const DEFAULT_LIMIT = 300;

export interface DelegatorCountSyncDeps {
  koios: { drepDelegatorCount(drepId: string): Promise<number | null> };
  db: D1Database;
  /** Unix-ms stamp written as delegator_count_synced_at for every count this run. */
  now: number;
  /** How many DReps to refresh this run. Defaults to DEFAULT_LIMIT. */
  limit?: number;
}

export interface DelegatorCountSyncResult {
  /** DReps selected for a refresh this run. */
  scanned: number;
  /** Counts successfully fetched and written. */
  updated: number;
  /** DReps whose count could not be fetched (error or unknown total). */
  failed: number;
}

export async function syncDrepDelegatorCounts(
  deps: DelegatorCountSyncDeps,
): Promise<DelegatorCountSyncResult> {
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const targets = await listDrepsForDelegatorCountRefresh(deps.db, limit);

  const writes: { drepId: string; delegatorCount: number; syncedAt: number }[] = [];
  let failed = 0;
  for (const { drepId } of targets) {
    try {
      const count = await deps.koios.drepDelegatorCount(drepId);
      if (count == null) {
        failed++;
        continue;
      }
      writes.push({ drepId, delegatorCount: count, syncedAt: deps.now });
    } catch {
      failed++;
    }
  }

  const updated = await updateDrepDelegatorCounts(deps.db, writes);
  return { scanned: targets.length, updated, failed };
}

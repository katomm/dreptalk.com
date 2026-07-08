// On-demand delegator-count refresh for a single DRep, run in the background from
// the profile page via waitUntil. Refreshes only when the stored count is missing
// or older than staleMs, so a viewed profile stays current without waiting on the
// 6h cron. Never throws: a Koios hiccup must not break a page render.

import { updateDrepDelegatorCounts } from '../db/dreps.js';

/** Consider a stored count stale after 6 hours (one cron cadence). */
export const DELEGATOR_COUNT_STALE_MS = 6 * 60 * 60 * 1000;

export interface DelegatorCountRefreshDeps {
  db: D1Database;
  koios: { drepDelegatorCount(drepId: string): Promise<number | null> };
  drep: { drepId: string; delegatorCountSyncedAt: number | null };
  now: number;
  staleMs?: number;
}

export async function maybeRefreshDelegatorCount(
  deps: DelegatorCountRefreshDeps,
): Promise<boolean> {
  const staleMs = deps.staleMs ?? DELEGATOR_COUNT_STALE_MS;
  const syncedAt = deps.drep.delegatorCountSyncedAt;
  if (syncedAt != null && deps.now - syncedAt < staleMs) return false;
  try {
    const count = await deps.koios.drepDelegatorCount(deps.drep.drepId);
    if (count == null) return false;
    await updateDrepDelegatorCounts(deps.db, [
      { drepId: deps.drep.drepId, delegatorCount: count, syncedAt: deps.now },
    ]);
    return true;
  } catch {
    return false;
  }
}

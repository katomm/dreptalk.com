/// <reference types="@cloudflare/workers-types" />
// DRep stake participation: total active DRep voting power.
// Lovelace fits SQLite INTEGER; the JS number is exact enough for the ratio and
// the rounded "B/M ada" display (we never do lovelace-exact accounting here).

import { SPECIAL_DREP_IDS } from '../dreps/special.js';

/**
 * Total active-DRep voting power (lovelace) and the freshness of that cached
 * number, in one read. `asOf` is the most recent active-DRep sync time (ms), or
 * null when no active DReps are synced (MAX over zero rows is NULL).
 */
export async function getActiveDrepStake(db: D1Database): Promise<{ total: number; asOf: number | null }> {
  // This is the representative DRep layer denominator per the two-layer
  // convention (see dreps/special.ts): the predefined options never count.
  // Before the dedicated specials sync existed these rows were simply absent
  // from `dreps`, so this guard makes that same behavior deliberate.
  const placeholders = SPECIAL_DREP_IDS.map(() => '?').join(', ');
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CAST(voting_power AS INTEGER)), 0) AS total, MAX(last_synced_at) AS asOf
       FROM dreps WHERE active = 1 AND drep_id NOT IN (${placeholders})`,
    )
    .bind(...SPECIAL_DREP_IDS)
    .first<{ total: number; asOf: number | null }>();
  return { total: row?.total ?? 0, asOf: row?.asOf ?? null };
}

/// <reference types="@cloudflare/workers-types" />
// DRep stake participation, computed from already-synced tables: total active
// DRep voting power, and the voting power that actually voted on each action.
// Lovelace fits SQLite INTEGER; the JS number is exact enough for the ratio and
// the rounded "B/M ADA" display (we never do lovelace-exact accounting here).

import { sqlPlaceholders } from './sql.js';

/** Total voting power (lovelace) across active DReps; 0 when unsynced. */
export async function getTotalDrepVotingPower(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(CAST(voting_power AS INTEGER)), 0) AS total FROM dreps WHERE active = 1")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Map of ga_id to summed DRep voting power that voted on it (any vote). */
export async function getVotedPowerByGaIds(db: D1Database, gaIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (gaIds.length === 0) return out;
  const placeholders = sqlPlaceholders(gaIds);
  const { results } = await db
    .prepare(
      `SELECT v.ga_id AS ga_id, COALESCE(SUM(CAST(d.voting_power AS INTEGER)), 0) AS voted
       FROM drep_votes v
       JOIN dreps d ON d.drep_id = v.voter_id
       WHERE v.voter_role = 'DRep' AND v.ga_id IN (${placeholders})
       GROUP BY v.ga_id`,
    )
    .bind(...gaIds)
    .all<{ ga_id: string; voted: number }>();
  for (const r of results ?? []) out.set(r.ga_id, r.voted);
  return out;
}

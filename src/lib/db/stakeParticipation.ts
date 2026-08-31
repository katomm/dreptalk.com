/// <reference types="@cloudflare/workers-types" />
// DRep stake participation: total active DRep voting power.
// Lovelace fits SQLite INTEGER; the JS number is exact enough for the ratio and
// the rounded "B/M ada" display (we never do lovelace-exact accounting here).

/**
 * Total active-DRep voting power (lovelace) and the freshness of that cached
 * number, in one read. `asOf` is the most recent active-DRep sync time (ms), or
 * null when no active DReps are synced (MAX over zero rows is NULL).
 */
export async function getActiveDrepStake(db: D1Database): Promise<{ total: number; asOf: number | null }> {
  // NOTE: this sum still includes the special auto-voting ids (they carry
  // active = 1). Whether the landing composition denominator should exclude
  // them is decided with the analytics hub PR, see dreps/special.ts.
  const row = await db
    .prepare("SELECT COALESCE(SUM(CAST(voting_power AS INTEGER)), 0) AS total, MAX(last_synced_at) AS asOf FROM dreps WHERE active = 1")
    .first<{ total: number; asOf: number | null }>();
  return { total: row?.total ?? 0, asOf: row?.asOf ?? null };
}

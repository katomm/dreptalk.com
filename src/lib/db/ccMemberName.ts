/// <reference types="@cloudflare/workers-types" />
// Current self-declared CC member display names (migration 0073). Newest vote
// wins, enforced in SQL by source_block_time so out-of-order async ingest is safe.
export interface CcNameRow {
  hotKeyHex: string;
  name: string;
  sourceBlockTime: number;
}

/** Canonical form for a committee key hash: trimmed, lower-case. */
export function normalizeKeyHex(s: string): string {
  return s.trim().toLowerCase();
}

/** Upsert a name for a hot key, keeping the row with the greatest source_block_time. */
export async function upsertCcMemberName(
  db: D1Database,
  rec: { hotKeyHex: string; name: string; sourceGaId: string | null; sourceBlockTime: number; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cc_member_name (hot_key_hex, name, source_ga_id, source_block_time, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hot_key_hex) DO UPDATE SET
         name = excluded.name, source_ga_id = excluded.source_ga_id,
         source_block_time = excluded.source_block_time, updated_at = excluded.updated_at
       WHERE excluded.source_block_time >= cc_member_name.source_block_time`,
    )
    .bind(normalizeKeyHex(rec.hotKeyHex), rec.name, rec.sourceGaId, rec.sourceBlockTime, rec.now)
    .run();
}

/** Every stored CC name (the table is tiny: a handful of members). */
export async function getAllCcMemberNames(db: D1Database): Promise<CcNameRow[]> {
  const res = await db
    .prepare('SELECT hot_key_hex, name, source_block_time FROM cc_member_name')
    .all<{ hot_key_hex: string; name: string; source_block_time: number }>();
  return (res.results ?? []).map((r) => ({ hotKeyHex: r.hot_key_hex, name: r.name, sourceBlockTime: r.source_block_time }));
}

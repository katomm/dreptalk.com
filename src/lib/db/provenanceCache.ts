// D1 access for the voting-power-origins cache (migration 0082). The payload
// is an opaque JSON string, TTL freshness is the caller's decision via
// computedAt. Rows hold aggregates and drep ids only, never stake addresses.

export interface ProvenanceCacheRow {
  computedAt: number;
  payload: string;
}

/** TTL for a cached analysis. Route-level freshness lives here so it is unit
    testable without a network-touching route test. */
export const PROVENANCE_CACHE_TTL_MS = 3 * 3600_000;

export function isFreshProvenanceCache(computedAt: number, now: number): boolean {
  return now - computedAt < PROVENANCE_CACHE_TTL_MS;
}

export async function getProvenanceCache(
  db: D1Database,
  drepId: string,
  windowEpochs: number,
): Promise<ProvenanceCacheRow | null> {
  const row = await db
    .prepare('SELECT computed_at, payload FROM provenance_cache WHERE drep_id = ? AND window_epochs = ?')
    .bind(drepId, windowEpochs)
    .first<{ computed_at: number; payload: string }>();
  return row ? { computedAt: row.computed_at, payload: row.payload } : null;
}

export async function putProvenanceCache(
  db: D1Database,
  drepId: string,
  windowEpochs: number,
  payload: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provenance_cache (drep_id, window_epochs, computed_at, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (drep_id, window_epochs) DO UPDATE SET
         computed_at = excluded.computed_at,
         payload = excluded.payload`,
    )
    .bind(drepId, windowEpochs, now, payload)
    .run();
}

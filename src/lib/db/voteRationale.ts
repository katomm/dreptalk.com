/// <reference types="@cloudflare/workers-types" />
// Content-addressed store for vote rationale documents. Mirrors db/drepMetadata.

export async function putVoteRationale(
  db: D1Database,
  rec: { hash: string; body: string; drepId: string; gaId: string; createdAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO vote_rationale (hash, body, drep_id, ga_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(rec.hash, rec.body, rec.drepId, rec.gaId, rec.createdAt)
    .run();
}

/** Returns the canonical JSON body for a hash, or null. */
export async function getVoteRationaleBody(db: D1Database, hash: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT body FROM vote_rationale WHERE hash = ?`)
    .bind(hash)
    .first<{ body: string }>();
  return row?.body ?? null;
}

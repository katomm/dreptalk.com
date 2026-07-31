/// <reference types="@cloudflare/workers-types" />
// Thin dedup/audit store for InfoAction CIP-108 metadata pinned to IPFS.
// Not served as the anchor (the anchor is ipfs://<cid>); this table lets a
// resubmission of identical content skip the re-upload, and gives audit and
// rate-limit context. Mirrors db/voteRationale and db/drepMetadata.

/** Returns the CID a hash was pinned under, or null if never stored. */
export async function getGovActionMetadata(
  db: D1Database,
  hash: string,
): Promise<{ cid: string } | null> {
  const row = await db
    .prepare(`SELECT cid FROM gov_action_metadata WHERE hash = ?`)
    .bind(hash)
    .first<{ cid: string }>();
  return row ? { cid: row.cid } : null;
}

export async function putGovActionMetadata(
  db: D1Database,
  rec: { hash: string; cid: string; body: string; createdAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO gov_action_metadata (hash, cid, body, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(rec.hash, rec.cid, rec.body, rec.createdAt)
    .run();
}

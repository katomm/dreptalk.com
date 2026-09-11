/// <reference types="@cloudflare/workers-types" />
// Thin dedup/audit store for InfoAction CIP-108 metadata pinned to IPFS.
// Not served as the anchor (the anchor is ipfs://<cid>); this table lets a
// resubmission of identical content skip the re-upload, and gives audit and
// rate-limit context. Mirrors db/voteRationale and db/drepMetadata.
//
// It is also the collector's only source of file ids: the Pinata account is
// shared with another project, so nothing here ever enumerates that account,
// and a row with a NULL pinata_file_id is by definition not ours to delete.

/** One document the collector may consider deleting. */
export interface CollectablePin {
  hash: string;
  cid: string;
  pinataFileId: string;
}

/**
 * Returns the CID a hash was pinned under, or null if never stored.
 *
 * Touches `last_served_at`, because handing a CID back is what restarts the
 * grace period: without it a user could resubmit a week-old draft, receive its
 * CID, and watch the collector delete that pin minutes later. A row already
 * marked for deletion is reported as absent, so the caller re-pins instead of
 * reusing a CID that is about to disappear. Re-pinning identical bytes returns
 * the identical CID, so nothing is lost by that.
 */
export async function getGovActionMetadata(
  db: D1Database,
  hash: string,
  now: number,
): Promise<{ cid: string } | null> {
  const row = await db
    .prepare(`SELECT cid FROM gov_action_metadata WHERE hash = ? AND deleting_at IS NULL`)
    .bind(hash)
    .first<{ cid: string }>();
  if (!row) return null;
  await db
    .prepare(`UPDATE gov_action_metadata SET last_served_at = ? WHERE hash = ? AND deleting_at IS NULL`)
    .bind(now, hash)
    .run();
  return { cid: row.cid };
}

export async function putGovActionMetadata(
  db: D1Database,
  rec: { hash: string; cid: string; body: string; createdAt: number; pinataFileId?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO gov_action_metadata (hash, cid, body, created_at, last_served_at, pinata_file_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(rec.hash, rec.cid, rec.body, rec.createdAt, rec.createdAt, rec.pinataFileId ?? null)
    .run();
}

/**
 * Documents whose pin is a candidate for collection: ours to delete, past the
 * grace cutoff, not anchored by any governance action we know of, and not
 * already given up on.
 *
 * Two guards that look redundant and are not. A file id may be shared by more
 * than one row (Pinata deduplicates by content), so a row is held back while
 * ANY row sharing its id is still anchored or still inside its grace window.
 * And the ordering is load-bearing: with a bare LIMIT, a full batch of
 * permanently failing rows is re-selected every run and starves everything
 * behind it, so the queue never drains.
 */
export async function getCollectablePins(
  db: D1Database,
  opts: { graceCutoff: number; maxAttempts: number; limit: number },
): Promise<CollectablePin[]> {
  const res = await db
    .prepare(
      `SELECT m.hash AS hash, m.cid AS cid, m.pinata_file_id AS pinata_file_id
         FROM gov_action_metadata m
        WHERE m.pinata_file_id IS NOT NULL
          AND m.deleting_at IS NULL
          AND m.last_served_at < ?
          AND m.delete_attempts < ?
          AND m.hash NOT IN (SELECT anchor_hash FROM governance_actions WHERE anchor_hash IS NOT NULL)
          AND NOT EXISTS (
                SELECT 1 FROM gov_action_metadata k
                 WHERE k.pinata_file_id = m.pinata_file_id
                   AND k.hash <> m.hash
                   AND (k.last_served_at >= ?
                        OR k.hash IN (SELECT anchor_hash FROM governance_actions
                                       WHERE anchor_hash IS NOT NULL)))
        ORDER BY m.delete_attempts ASC, m.last_served_at ASC
        LIMIT ?`,
    )
    .bind(opts.graceCutoff, opts.maxAttempts, opts.graceCutoff, opts.limit)
    .all<{ hash: string; cid: string; pinata_file_id: string }>();
  return (res.results ?? []).map((r) => ({ hash: r.hash, cid: r.cid, pinataFileId: r.pinata_file_id }));
}

/** How many collectable rows are waiting, for the backlog log line. */
export async function countCollectablePins(
  db: D1Database,
  opts: { graceCutoff: number; maxAttempts: number },
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM gov_action_metadata m
        WHERE m.pinata_file_id IS NOT NULL
          AND m.deleting_at IS NULL
          AND m.last_served_at < ?
          AND m.delete_attempts < ?
          AND m.hash NOT IN (SELECT anchor_hash FROM governance_actions WHERE anchor_hash IS NOT NULL)`,
    )
    .bind(opts.graceCutoff, opts.maxAttempts)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Claims a row for deletion. Returns false when another run already holds it,
 * so two overlapping cron ticks cannot both delete the same file.
 */
export async function markPinDeleting(db: D1Database, hash: string, now: number): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE gov_action_metadata SET deleting_at = ? WHERE hash = ? AND deleting_at IS NULL`)
    .bind(now, hash)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Releases a claim after a failed delete and counts the attempt, so a row that
 * keeps failing eventually drops out of the selection instead of blocking it.
 */
export async function releasePinDeleting(db: D1Database, hash: string): Promise<void> {
  await db
    .prepare(
      `UPDATE gov_action_metadata
          SET deleting_at = NULL, delete_attempts = delete_attempts + 1
        WHERE hash = ?`,
    )
    .bind(hash)
    .run();
}

/** Drops the row once its pin is gone. Only ever called after a successful delete. */
export async function deleteGovActionMetadata(db: D1Database, hash: string): Promise<void> {
  await db.prepare(`DELETE FROM gov_action_metadata WHERE hash = ?`).bind(hash).run();
}

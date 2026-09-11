/// <reference types="@cloudflare/workers-types" />
// Thin dedup/audit store for InfoAction CIP-108 metadata pinned to IPFS.
// Not served as the anchor (the anchor is ipfs://<cid>); this table lets a
// resubmission of identical content skip the re-upload, and gives audit and
// rate-limit context. Mirrors db/voteRationale and db/drepMetadata.
//
// It is also the collector's work queue, and its only source of file ids: the
// Pinata account is shared with another project, so nothing ever enumerates
// that account, and a row with a NULL pinata_file_id is by definition not ours
// to delete. An attempt counter on the domain table is the house pattern for
// this (meta_attempts on governance_actions, image_fetch_attempts on dreps).
//
// One invariant the queries lean on: hash, bytes and cid are 1:1. `hash` is
// blake2b of the exact document bytes and `cid` is the IPFS hash of those same
// bytes, so two rows cannot describe the same content, and a duplicate upload
// never records a file id at all (see pinata.ts). Two rows therefore cannot
// share a pinata_file_id, which is why nothing here guards against it.

/** One document the collector may consider deleting. */
export interface CollectablePin {
  hash: string;
  pinataFileId: string;
}

/**
 * Hands a previously pinned CID back to a submitter, or null if there is none.
 *
 * Named for the write it performs rather than the read it looks like: serving a
 * CID restarts the grace period, so a week-old draft resubmitted now cannot
 * have its pin collected minutes later. A plain getter would let any future
 * read path extend that clock by accident.
 *
 * A row claimed for deletion reads as absent, so the caller re-pins instead of
 * reusing a CID that is about to disappear. Re-pinning identical bytes yields
 * the identical CID, so nothing is lost.
 */
export async function serveGovActionMetadata(
  db: D1Database,
  hash: string,
  now: number,
): Promise<{ cid: string } | null> {
  const row = await db
    .prepare(
      `UPDATE gov_action_metadata SET last_served_at = ?
        WHERE hash = ? AND deleting_at IS NULL
        RETURNING cid`,
    )
    .bind(now, hash)
    .first<{ cid: string }>();
  return row ? { cid: row.cid } : null;
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

// The one definition of "collectable", shared by the selection and its count so
// the two can never drift into reporting different populations. `deleting_at`
// is a LEASE, not a lock: a run killed mid-flight would otherwise strand a row
// that is never served and never re-selected, so a stale claim is reclaimed the
// way runRecorder reaps stale sync runs.
const COLLECTABLE_WHERE = `
        WHERE pinata_file_id IS NOT NULL
          AND (deleting_at IS NULL OR deleting_at < ?)
          AND last_served_at < ?
          AND hash NOT IN (SELECT anchor_hash FROM governance_actions WHERE anchor_hash IS NOT NULL)`;

export interface CollectableOpts {
  /** Unix seconds; rows served after this are still protected. */
  graceCutoff: number;
  /** Unix seconds; a claim older than this is treated as abandoned. */
  staleClaimCutoff: number;
  limit: number;
}

/**
 * Documents whose pin is a candidate for collection, plus how many are waiting
 * in total.
 *
 * The total comes from a window function rather than a second query, so the
 * backlog figure is always the same population the selection draws from.
 *
 * The ordering is load-bearing: with a bare LIMIT, rows that keep failing are
 * re-selected every run and starve everything behind them. Fewest attempts
 * first means a poison row drifts to the back instead of blocking the queue,
 * which is why there is no attempt cutoff. A cutoff would retire rows
 * permanently after a couple of hours of Pinata being down, which is worse than
 * occasionally retrying a genuinely dead one.
 */
export async function getCollectablePins(
  db: D1Database,
  opts: CollectableOpts,
): Promise<{ pins: CollectablePin[]; total: number }> {
  const res = await db
    .prepare(
      `SELECT hash, pinata_file_id, COUNT(*) OVER () AS total
         FROM gov_action_metadata
         ${COLLECTABLE_WHERE}
        ORDER BY delete_attempts ASC, last_served_at ASC
        LIMIT ?`,
    )
    .bind(opts.staleClaimCutoff, opts.graceCutoff, opts.limit)
    .all<{ hash: string; pinata_file_id: string; total: number }>();
  const rows = res.results ?? [];
  return {
    pins: rows.map((r) => ({ hash: r.hash, pinataFileId: r.pinata_file_id })),
    total: rows[0]?.total ?? 0,
  };
}

/**
 * Claims a row for deletion. Returns false when another run already holds it,
 * so two overlapping cron ticks cannot both delete the same file.
 */
export async function markPinDeleting(
  db: D1Database,
  hash: string,
  now: number,
  staleClaimCutoff: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE gov_action_metadata SET deleting_at = ?
        WHERE hash = ? AND (deleting_at IS NULL OR deleting_at < ?)`,
    )
    .bind(now, hash, staleClaimCutoff)
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

/**
 * Marks a row as not ours to delete, permanently, by forgetting the file id.
 *
 * For a file that turned out to sit outside our Pinata group. Retrying it would
 * be pointless, since it can never become ours, and burning delete_attempts on
 * it would repeat the alarm five times before going quiet. The row and its CID
 * stay: the document is still served, it simply leaves the collector's reach.
 */
export async function disownPin(db: D1Database, hash: string): Promise<void> {
  await db
    .prepare(`UPDATE gov_action_metadata SET pinata_file_id = NULL, deleting_at = NULL WHERE hash = ?`)
    .bind(hash)
    .run();
}

/** Drops the row once its pin is gone. Only ever called after a successful delete. */
export async function deleteGovActionMetadata(db: D1Database, hash: string): Promise<void> {
  await db.prepare(`DELETE FROM gov_action_metadata WHERE hash = ?`).bind(hash).run();
}

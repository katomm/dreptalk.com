/// <reference types="@cloudflare/workers-types" />
// src/lib/db/cip100.ts
// D1 access for emitted CIP-100 documents. Every write to cip100_docs goes
// through here, and every read that serves bytes joins the live posts/topics
// deleted flags, so a manual `UPDATE posts SET deleted = 1` takes effect
// immediately without any other step.

export interface Cip100DocRow {
  hash: string;
  postId: string;
  topicId: string;
  version: number;
  prevHash: string | null;
  sourceEditedAt: number | null;
  createdAt: number;
}

export interface InsertDocInput {
  hash: string;
  body: string;
  postId: string;
  topicId: string;
  version: number;
  prevHash: string | null;
  sourceEditedAt: number | null;
  createdAt: number;
}

/** 'inserted' on a new row, 'duplicate' when these exact bytes already exist,
 *  'conflict' when another writer already took this version number. */
export type InsertDocResult = 'inserted' | 'duplicate' | 'conflict';

export async function insertDoc(db: D1Database, rec: InsertDocInput): Promise<InsertDocResult> {
  // INSERT OR IGNORE swallows both the hash PK and the (post_id, version)
  // UNIQUE, so the caller cannot tell them apart from the statement alone.
  // Re-reading tells us which one it was: same hash means an identical
  // document is already stored (harmless), anything else means we lost a race
  // for this version number and must rebuild against the new head.
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO cip100_docs
         (hash, body, post_id, topic_id, version, prev_hash, source_edited_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(rec.hash, rec.body, rec.postId, rec.topicId, rec.version, rec.prevHash, rec.sourceEditedAt, rec.createdAt)
    .run();
  if ((res.meta?.changes ?? 0) > 0) return 'inserted';
  const existing = await db
    .prepare('SELECT hash FROM cip100_docs WHERE post_id = ? AND version = ?')
    .bind(rec.postId, rec.version)
    .first<{ hash: string }>();
  return existing?.hash === rec.hash ? 'duplicate' : 'conflict';
}

/**
 * Serving state of one document.
 * - `gone`: the post or its topic is flagged deleted. Terminal, and the erasure
 *   path, so the route answers 410.
 * - `hidden`: the post is hidden by community flags. Reversible, so the route
 *   answers 404. A 410 would claim a permanent erasure that has not happened.
 * - `available`: serve the bytes.
 */
export type DocServeState = 'available' | 'gone' | 'hidden';

/** Bytes plus serving state for one hash, both read from the live post and
 *  topic flags, whether or not the purge sweep has run yet. Deletion wins over
 *  hiding: a post that is both is gone. */
export async function getDocForServe(
  db: D1Database,
  hash: string,
): Promise<{ body: string | null; state: DocServeState } | null> {
  const row = await db
    .prepare(
      `SELECT d.body AS body,
              CASE WHEN p.deleted = 1 OR COALESCE(t.deleted, 0) = 1 THEN 'gone'
                   WHEN p.hidden = 1 THEN 'hidden'
                   ELSE 'available' END AS state
         FROM cip100_docs d
         JOIN posts p ON p.id = d.post_id
         LEFT JOIN topics t ON t.id = d.topic_id
        WHERE d.hash = ?`,
    )
    .bind(hash)
    .first<{ body: string | null; state: DocServeState }>();
  if (!row) return null;
  return { body: row.body, state: row.state };
}

export async function getHeadDoc(db: D1Database, postId: string): Promise<Cip100DocRow | null> {
  const row = await db
    .prepare(
      `SELECT hash, post_id, topic_id, version, prev_hash, source_edited_at, created_at
         FROM cip100_docs WHERE post_id = ? ORDER BY version DESC, created_at DESC LIMIT 1`,
    )
    .bind(postId)
    .first<{
      hash: string; post_id: string; topic_id: string; version: number;
      prev_hash: string | null; source_edited_at: number | null; created_at: number;
    }>();
  if (!row) return null;
  return {
    hash: row.hash, postId: row.post_id, topicId: row.topic_id, version: row.version,
    prevHash: row.prev_hash, sourceEditedAt: row.source_edited_at, createdAt: row.created_at,
  };
}

/** The document of `postId` that was current at `at`: its newest version
 *  emitted at or before that moment. Returns null when none exists, which
 *  is the backfill case where the parent's only snapshots postdate the
 *  reply. Deterministic, so rebuilding a reply's document years later
 *  still resolves the same parent snapshot. */
export async function getDocAtOrBefore(
  db: D1Database,
  postId: string,
  at: number,
): Promise<{ hash: string; version: number; createdAt: number } | null> {
  const row = await db
    .prepare(
      `SELECT hash, version, created_at FROM cip100_docs
        WHERE post_id = ? AND created_at <= ?
        ORDER BY version DESC, created_at DESC LIMIT 1`,
    )
    .bind(postId, at)
    .first<{ hash: string; version: number; created_at: number }>();
  if (!row) return null;
  return { hash: row.hash, version: row.version, createdAt: row.created_at };
}

/** Returns the stored bytes for a hash without the liveness join. Used by the
 *  reconciler to compare the head's comment with a freshly built one. */
export async function getDocBody(db: D1Database, hash: string): Promise<string | null> {
  const row = await db.prepare('SELECT body FROM cip100_docs WHERE hash = ?').bind(hash).first<{ body: string | null }>();
  return row?.body ?? null;
}

/** Records which post state the head was reconciled against. Metadata only:
 *  the stored bytes and the hash are never touched. */
export async function touchSourceEditedAt(db: D1Database, hash: string, sourceEditedAt: number | null): Promise<void> {
  await db.prepare('UPDATE cip100_docs SET source_edited_at = ? WHERE hash = ?').bind(sourceEditedAt, hash).run();
}

export async function listPostVersions(
  db: D1Database,
  postId: string,
): Promise<Array<{ hash: string; version: number; createdAt: number }>> {
  const res = await db
    .prepare('SELECT hash, version, created_at FROM cip100_docs WHERE post_id = ? ORDER BY version, created_at')
    .bind(postId)
    .all<{ hash: string; version: number; created_at: number }>();
  return (res.results ?? []).map((r) => ({ hash: r.hash, version: r.version, createdAt: r.created_at }));
}

/** All documents of one thread, oldest post first, for the manifest. */
export async function listThreadDocs(
  db: D1Database,
  topicId: string,
): Promise<Array<{ hash: string; postId: string; version: number; createdAt: number }>> {
  const res = await db
    .prepare(
      `SELECT d.hash, d.post_id, d.version, d.created_at
         FROM cip100_docs d WHERE d.topic_id = ? ORDER BY d.post_id, d.version`,
    )
    .bind(topicId)
    .all<{ hash: string; post_id: string; version: number; created_at: number }>();
  return (res.results ?? []).map((r) => ({
    hash: r.hash, postId: r.post_id, version: r.version, createdAt: r.created_at,
  }));
}

/** The post ids in one thread that have at least one document, regardless of
 *  whether the bytes have since been purged (a tombstoned post still serves a
 *  200). Drives the Cite affordance: a post without a document has no version
 *  index at all, and a visible link leading to a 404 would be worse than no
 *  link. One indexed read per thread render. */
export async function listPostIdsWithDocs(db: D1Database, topicId: string): Promise<Set<string>> {
  const res = await db
    .prepare('SELECT DISTINCT post_id FROM cip100_docs WHERE topic_id = ?')
    .bind(topicId)
    .all<{ post_id: string }>();
  return new Set((res.results ?? []).map((r) => r.post_id));
}

/** Erasure: drops the bytes of every document whose post or topic is flagged
 *  deleted. Idempotent, and safe to run on every cron tick. */
export async function purgeDeletedDocs(db: D1Database, now: number): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE cip100_docs SET body = NULL, deleted_at = ?
        WHERE body IS NOT NULL
          AND post_id IN (
            SELECT p.id FROM posts p
              LEFT JOIN topics t ON t.id = p.topic_id
             WHERE p.deleted = 1 OR COALESCE(t.deleted, 0) = 1
          )`,
    )
    .bind(now)
    .run();
  return res.meta?.changes ?? 0;
}

/** Stamps a deletion time on rows that were flagged without one (manual SQL).
 *  Both topics.deleted_at and posts.deleted_at are stamped, for every row that
 *  was flagged deleted without a timestamp. The value is an upper bound, the
 *  time the deletion was recorded, not the real moment, see the spec section
 *  11. It exists so a tombstone always has a timestamp available, including
 *  for posts inside a thread that was deleted as a whole: the version index
 *  reads the post's deleted_at and falls back to the topic's when the post
 *  has none, which only works if both columns are actually stamped. */
export async function stampMissingDeletedAt(db: D1Database, now: number): Promise<number> {
  const [topics, posts] = await db.batch([
    db.prepare('UPDATE topics SET deleted_at = ? WHERE deleted = 1 AND deleted_at IS NULL').bind(now),
    db.prepare('UPDATE posts SET deleted_at = ? WHERE deleted = 1 AND deleted_at IS NULL').bind(now),
  ]);
  return (topics.meta?.changes ?? 0) + (posts.meta?.changes ?? 0);
}

/**
 * Posts whose documents are missing or behind. Two branches, and both are
 * needed: "no document yet" alone would never revisit a post whose later
 * version failed to emit, which is the bug that makes a repair loop useless.
 * graceCutoff is `now - EDIT_GRACE_MS`: before that a post is still editable
 * silently, so version 1 must not exist yet.
 */
export async function findStalePostIds(db: D1Database, graceCutoff: number, limit: number): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT p.id AS id
         FROM posts p
         JOIN topics t ON t.id = p.topic_id
         LEFT JOIN cip100_docs h
                ON h.post_id = p.id
               AND h.version = (SELECT MAX(version) FROM cip100_docs WHERE post_id = p.id)
        WHERE p.deleted = 0 AND t.deleted = 0
          AND p.hidden = 0
          AND (
               (h.hash IS NULL AND p.created_at <= ?)
            OR (p.edited_at IS NOT NULL AND p.edited_at > COALESCE(h.source_edited_at, 0))
          )
        ORDER BY p.created_at
        LIMIT ?`,
    )
    .bind(graceCutoff, limit)
    .all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}

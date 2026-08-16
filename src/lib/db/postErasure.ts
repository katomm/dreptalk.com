/// <reference types="@cloudflare/workers-types" />
// src/lib/db/postErasure.ts
// The one path that erases a deleted post's text. Every store a post's wording
// lives in goes through here: the live bodies, the archived revisions, and the
// emitted CIP-100 bytes.
//
// The search index is deliberately not written. posts_fts is an external
// content table whose posts_fts_au trigger (migration 0019) fires on a real
// change to body_md, removes the old tokens with the correct old values and
// indexes the new ones, inside the same transaction. Writing to posts_fts by
// hand here would be the bug, not the fix.

/**
 * How long a deleted post keeps its text so that abuse can still be dealt with.
 * Deletion takes the post out of every read path at once. This window is only
 * about the bytes at rest.
 *
 * Quoted as "30 days" in /help/citing-a-post/, /help/moderation/, /privacy and
 * the `erasure` field of /.well-known/cip-100.json. Changing it here means
 * changing it there.
 */
export const POST_ERASURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// A post is erasable while it is deleted, or while its thread is, AND while
// that deletion is older than the caller's cutoff. Both flag states are
// permanent and both already answer 410 (see getDocForServe), so both are
// erasures.
//
// The time test belongs here and not only in the sweep's candidate query. The
// sweep selects in one D1 call and erases in another, so between the two a post
// can be revived and deleted again, which resets its deletion clock. A guard
// that only asked "is it deleted" would then erase text that was deleted
// seconds ago and is owed a full retention window. Repeating the cutoff inside
// the batch makes state and time a single atomic compare-and-act, which is the
// whole reason the guard exists.
//
// Each branch pairs a flag with its own table's timestamp and never reads one
// across from the other. deleted_at is not authoritative on a row whose flag is
// not set, so a COALESCE over both would let a stale value decide.
//
// One definition, three uses. The sweep's selection predicate covers both flags
// and the same cutoff, so the guard must too: an earlier draft guarded only
// posts.deleted while the sweep selected on both, which meant a live post inside
// a deleted thread was selected on every run and then silently ignored by all
// three statements. Numbered parameters, so the fragment can be pasted into
// statements with different binds: ?1 is the post id, ?2 the cutoff. No user
// data is interpolated.
const ERASABLE = `EXISTS (
    SELECT 1 FROM posts p LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.id = ?1
       AND ( (p.deleted = 1 AND p.deleted_at <= ?2)
          OR (COALESCE(t.deleted, 0) = 1 AND t.deleted_at <= ?2) )
  )`;

/** Rows changed by each statement, so a caller can tell a real erasure from a no-op. */
export interface ErasureResult {
  bodies: number;
  revisions: number;
  docs: number;
}

/**
 * Erases one post's text everywhere it is stored, in a single D1 batch.
 *
 * A batch is one transaction whose statements run in order and roll back
 * together, so all three guards see the same state and the post is either fully
 * erased or fully untouched, never left with its body intact and its revisions
 * gone. That matters because upsertVoteRationalePost can revive a soft-deleted
 * cross-post at any moment.
 *
 * `cutoff` is the retention boundary: the deletion must be at or before it. The
 * sweep passes `now - POST_ERASURE_RETENTION_MS`. A caller that means to erase
 * without waiting passes `cutoff` equal to `now`, which erases anything already
 * flagged and stamped. A row flagged deleted but never stamped is erased by
 * neither, because `NULL <= ?` is NULL, and that is deliberate: a deletion with
 * no known date is exactly the case where guessing destroys text nobody
 * promised to destroy.
 */
export async function erasePostContent(
  db: D1Database,
  postId: string,
  opts: { now: number; cutoff: number },
): Promise<ErasureResult> {
  // Counted via RETURNING and results.length, not meta.changes. sqlite3_changes()
  // includes rows written by triggers fired as a side effect of the statement, and
  // the posts UPDATE fires posts_fts_au (migration 0019), which writes into the
  // FTS5 shadow tables on every real body_md change. That inflates meta.changes
  // for the posts statement to a number with no meaning to a caller, well past the
  // single row actually erased. RETURNING reports exactly the rows the statement
  // itself matched, unaffected by what its triggers go on to do.
  const [bodies, revisions, docs] = await db.batch([
    // body_md and body_html are NOT NULL (migration 0002), so erasure is an
    // overwrite. The empty string doubles as the "already erased" marker, which
    // is what makes a second pass write zero rows. D1 bills rows written.
    db
      .prepare(
        `UPDATE posts SET body_md = '', body_html = ''
          WHERE id = ?1 AND (body_md <> '' OR body_html <> '') AND ${ERASABLE}
          RETURNING id`,
      )
      .bind(postId, opts.cutoff),
    db
      .prepare(`DELETE FROM post_revisions WHERE post_id = ?1 AND ${ERASABLE} RETURNING id`)
      .bind(postId, opts.cutoff),
    db
      .prepare(
        `UPDATE cip100_docs SET body = NULL, deleted_at = ?3
          WHERE post_id = ?1 AND body IS NOT NULL AND ${ERASABLE}
          RETURNING hash`,
      )
      .bind(postId, opts.cutoff, opts.now),
  ]);
  return {
    bodies: bodies.results.length,
    revisions: revisions.results.length,
    docs: docs.results.length,
  };
}

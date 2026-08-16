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

// Posts whose retention window has passed and that still hold text somewhere.
//
// Two UNION branches rather than one OR with a COALESCE over both timestamps,
// for correctness before speed. deleted_at is not cleared on revive, so a
// cross-post that was opted out and opted back in carries a stale timestamp.
// Reading that value through a COALESCE would let a thread deleted this morning
// qualify its posts for erasure at once. Pairing each flag with its own table's
// timestamp makes that impossible rather than merely guarded against.
//
// It is also the same semantics as taking the earlier of the two clocks:
// MIN(a, b) <= cutoff and (a <= cutoff OR b <= cutoff) are the same predicate.
// Earlier is correct, because the content has been unreachable since the first
// of the two deletions and a later thread deletion must not extend a post's
// retention.
//
// A NULL timestamp is never selected: NULL <= ? is NULL, so a row flagged but
// not yet stamped waits for the stamp above.
//
// The final OR block is what keeps an erased post out of the set. Without it an
// erased post would keep matching the deleted-and-expired predicate forever and
// the sweep would rewrite the same rows every tick. It also makes the sweep
// self-healing: if a revision or a document ever appears after an erasure, the
// post is picked up again.
// UNION ALL plus MIN, rather than a plain UNION, so the earliest active
// deletion time survives as a sort key. Taking the minimum is the same
// predicate as either branch qualifying, and it is the timestamp the CIP-100
// tombstone publishes, so the two cannot disagree about when a post was
// deleted.
const EXPIRED_CANDIDATES = `
  WITH expired AS (
    SELECT p.id AS id, p.deleted_at AS ts FROM posts p
     WHERE p.deleted = 1 AND p.deleted_at <= ?1
    UNION ALL
    SELECT p.id, t.deleted_at FROM posts p JOIN topics t ON t.id = p.topic_id
     WHERE t.deleted = 1 AND t.deleted_at <= ?1
  ),
  due AS (SELECT id, MIN(ts) AS ts FROM expired GROUP BY id)
  SELECT p.id AS id, d.ts AS ts
    FROM posts p JOIN due d ON d.id = p.id
   WHERE p.body_md <> '' OR p.body_html <> ''
      OR EXISTS (SELECT 1 FROM post_revisions r WHERE r.post_id = p.id)
      OR EXISTS (SELECT 1 FROM cip100_docs d2 WHERE d2.post_id = p.id AND d2.body IS NOT NULL)`;

/**
 * Stamps a deletion time on any row flagged deleted without one. Manual SQL
 * (`UPDATE posts SET deleted = 1 WHERE ...`) is how most real deletions happen,
 * and this is what lets such a deletion join the lifecycle without the person
 * typing it having to know the lifecycle exists.
 *
 * The stamp is an upper bound, not the true deletion time, which is why an
 * already-deleted backlog gets a fresh window rather than being erased at once.
 * Erasing on a guessed date destroys text nobody promised to destroy, waiting
 * costs storage.
 */
export async function stampMissingDeletedAt(db: D1Database, now: number): Promise<number> {
  const [topics, posts] = await db.batch([
    db.prepare('UPDATE topics SET deleted_at = ? WHERE deleted = 1 AND deleted_at IS NULL').bind(now),
    db.prepare('UPDATE posts SET deleted_at = ? WHERE deleted = 1 AND deleted_at IS NULL').bind(now),
  ]);
  return (topics.meta?.changes ?? 0) + (posts.meta?.changes ?? 0);
}

export interface PostErasureSweepResult {
  /** Deletion timestamps written for rows flagged without one. */
  stamped: number;
  /** Posts whose text was actually removed this run. */
  erased: number;
  /** Posts whose batch threw. Logged with their ids and retried next run. */
  failed: number;
  /** Candidates still waiting after this run, so a backlog that is not draining is visible. */
  remaining: number;
}

/**
 * Finds posts past their retention window and erases them, one batch each.
 *
 * Runs as the `post-erasure` gov-sync phase, before the `cip100` phase, because
 * the tombstones that phase renders read the timestamps stamped here.
 */
/**
 * The deletion time that governs a post: the earliest one whose flag is
 * actually set, or null when neither is.
 *
 * This is the TypeScript form of what the sweep's candidate query computes in
 * SQL with `MIN(ts)` over the two UNION branches. Both exist because two
 * surfaces need the same answer: the sweep decides when to erase, and the
 * CIP-100 tombstone publishes when the post was deleted. If they disagree, an
 * observer sees the bytes vanish on a date the tombstone does not claim.
 *
 * A timestamp is only read when its own flag is set, for the same reason as in
 * the query: deleted_at is not cleared on every path that clears the flag.
 */
export function earliestActiveDeletion(
  postDeletedAt: number | null,
  topicDeletedAt: number | null,
): number | null {
  if (postDeletedAt === null) return topicDeletedAt;
  if (topicDeletedAt === null) return postDeletedAt;
  return Math.min(postDeletedAt, topicDeletedAt);
}

export async function runPostErasureSweep(
  db: D1Database,
  opts: { now: number; limit: number; retentionMs?: number },
): Promise<PostErasureSweepResult> {
  const cutoff = opts.now - (opts.retentionMs ?? POST_ERASURE_RETENTION_MS);

  const stamped = await stampMissingDeletedAt(db, opts.now);

  // Longest overdue first, not oldest post first. With a backlog, the erasures
  // that have been owed the longest are the ones to clear.
  const rows = await db
    .prepare(`${EXPIRED_CANDIDATES} ORDER BY d.ts LIMIT ?2`)
    .bind(cutoff, opts.limit)
    .all<{ id: string; ts: number }>();

  let erased = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    // Fail soft, per post. Ordering is deterministic, so one row that always
    // throws would otherwise take the whole sweep down with it on every run and
    // block every erasure behind it forever. The same shape as the cip100
    // reconcile loop, for the same reason. The failure stays visible through
    // `failed` and through a `remaining` that stops falling.
    try {
      const res = await erasePostContent(db, row.id, { now: opts.now, cutoff });
      if (res.bodies > 0 || res.revisions > 0 || res.docs > 0) erased++;
    } catch (err) {
      failed++;
      console.error(`[post-erasure] failed for post ${row.id}:`, err);
    }
  }

  // Counted after the erasures, so it is the true backlog rather than a
  // pre-count of what this run was about to do.
  const rest = await db
    .prepare(`SELECT COUNT(*) AS n FROM (${EXPIRED_CANDIDATES})`)
    .bind(cutoff)
    .first<{ n: number }>();

  return { stamped, erased, failed, remaining: rest?.n ?? 0 };
}

/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for community post flagging.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
//
// Each writer can flag a post at most once (enforced by the post_flags composite
// primary key). After every flag or unflag, posts.flag_count is recomputed as the
// number of distinct flaggers and posts.hidden is set when that count reaches the
// threshold, so the hidden state is always consistent with the flags table.

// Distinct flaggers required to hide a post. Kept low on purpose: every flagger
// is a wallet-verified on-chain writer, so few flags signal real consensus.
export const FLAG_HIDE_THRESHOLD = 3;

export interface FlagState {
  flagCount: number;
  hidden: boolean;
}

/** Recompute statement: sets flag_count to the distinct flag count and hidden when it meets the threshold. */
function recomputeStmt(db: D1Database, postId: string, threshold: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE posts
         SET flag_count = (SELECT COUNT(*) FROM post_flags WHERE post_id = ?1),
             hidden = CASE WHEN (SELECT COUNT(*) FROM post_flags WHERE post_id = ?1) >= ?2 THEN 1 ELSE 0 END
       WHERE id = ?1`,
    )
    .bind(postId, threshold);
}

/**
 * Runs the flag mutation, the recompute, and the state read-back as one batched
 * transaction (a single D1 round-trip), then returns the post's new flag state.
 */
async function applyAndRead(
  db: D1Database,
  mutate: D1PreparedStatement,
  postId: string,
  threshold: number,
): Promise<FlagState> {
  const read = db.prepare('SELECT flag_count, hidden FROM posts WHERE id = ?').bind(postId);
  const results = await db.batch([mutate, recomputeStmt(db, postId, threshold), read]);
  const row = results[2]?.results?.[0] as { flag_count: number; hidden: number } | undefined;
  return { flagCount: row?.flag_count ?? 0, hidden: row?.hidden === 1 };
}

/**
 * Records a flag from flaggerId on postId (idempotent: a repeat flag by the same
 * writer is a no-op via INSERT OR IGNORE), then recomputes the post's flag state
 * atomically. Returns the new flag count and hidden state.
 */
export async function flagPost(
  db: D1Database,
  args: { postId: string; flaggerId: string; now: number },
  threshold = FLAG_HIDE_THRESHOLD,
): Promise<FlagState> {
  const { postId, flaggerId, now } = args;
  const insert = db
    .prepare('INSERT OR IGNORE INTO post_flags (post_id, flagger_id, created_at) VALUES (?, ?, ?)')
    .bind(postId, flaggerId, now);

  return applyAndRead(db, insert, postId, threshold);
}

/**
 * Withdraws flaggerId's flag from postId (no-op if absent), then recomputes the
 * post's flag state atomically. If the count drops below the threshold the post
 * un-hides. Returns the new flag count and hidden state.
 */
export async function unflagPost(
  db: D1Database,
  args: { postId: string; flaggerId: string },
  threshold = FLAG_HIDE_THRESHOLD,
): Promise<FlagState> {
  const { postId, flaggerId } = args;
  const remove = db
    .prepare('DELETE FROM post_flags WHERE post_id = ? AND flagger_id = ?')
    .bind(postId, flaggerId);

  return applyAndRead(db, remove, postId, threshold);
}

/**
 * Returns the subset of postIds that flaggerId has already flagged, in a single
 * query (no N+1). Used to render each post's flag button in the correct state.
 */
export async function getFlaggedPostIds(
  db: D1Database,
  flaggerId: string,
  postIds: string[],
): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();

  const placeholders = postIds.map(() => '?').join(', ');
  const rows = (
    await db
      .prepare(
        `SELECT post_id FROM post_flags WHERE flagger_id = ? AND post_id IN (${placeholders})`,
      )
      .bind(flaggerId, ...postIds)
      .all<{ post_id: string }>()
  ).results ?? [];

  return new Set(rows.map((r) => r.post_id));
}

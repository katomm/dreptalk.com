/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for post reactions (thumbs up / thumbs down).
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
//
// Each writer holds at most one reaction per post (composite primary key);
// setting the other side replaces it. After every change, posts.up_count and
// posts.down_count are recomputed from the reactions table in the same batch,
// so the materialized counts are always consistent.

import { sqlPlaceholders } from './sql.js';

export type Reaction = 'up' | 'down';

export function isReaction(value: unknown): value is Reaction {
  return value === 'up' || value === 'down';
}

export interface ReactionState {
  upCount: number;
  downCount: number;
}

/** Recompute statement: refreshes both materialized counts from post_reactions. */
function recomputeStmt(db: D1Database, postId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE posts
         SET up_count   = (SELECT COUNT(*) FROM post_reactions WHERE post_id = ?1 AND reaction = 'up'),
             down_count = (SELECT COUNT(*) FROM post_reactions WHERE post_id = ?1 AND reaction = 'down')
       WHERE id = ?1`,
    )
    .bind(postId);
}

/**
 * Runs the reaction mutation, the recompute, and the state read-back as one
 * batched transaction (a single D1 round-trip), then returns the new counts.
 */
async function applyAndRead(
  db: D1Database,
  mutate: D1PreparedStatement,
  postId: string,
): Promise<ReactionState> {
  const read = db.prepare('SELECT up_count, down_count FROM posts WHERE id = ?').bind(postId);
  const results = await db.batch([mutate, recomputeStmt(db, postId), read]);
  const row = results[2]?.results?.[0] as { up_count: number; down_count: number } | undefined;
  return { upCount: row?.up_count ?? 0, downCount: row?.down_count ?? 0 };
}

/**
 * Sets reactorId's reaction on postId (replacing any previous one via the
 * primary-key upsert), then recomputes the post's counts atomically.
 */
export async function setReaction(
  db: D1Database,
  args: { postId: string; reactorId: string; reaction: Reaction; now: number },
): Promise<ReactionState> {
  const { postId, reactorId, reaction, now } = args;
  const upsert = db
    .prepare(
      `INSERT INTO post_reactions (post_id, reactor_id, reaction, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (post_id, reactor_id) DO UPDATE SET reaction = excluded.reaction`,
    )
    .bind(postId, reactorId, reaction, now);

  return applyAndRead(db, upsert, postId);
}

/**
 * Withdraws reactorId's reaction from postId (no-op if absent), then recomputes
 * the post's counts atomically.
 */
export async function clearReaction(
  db: D1Database,
  args: { postId: string; reactorId: string },
): Promise<ReactionState> {
  const { postId, reactorId } = args;
  const remove = db
    .prepare('DELETE FROM post_reactions WHERE post_id = ? AND reactor_id = ?')
    .bind(postId, reactorId);

  return applyAndRead(db, remove, postId);
}

/**
 * Statement selecting reactorId's current reaction for each of postIds.
 * Exported so the thread view can run it inside one batch with other
 * per-viewer lookups (a single D1 round-trip).
 */
export function viewerReactionsStmt(
  db: D1Database,
  reactorId: string,
  postIds: string[],
): D1PreparedStatement {
  const placeholders = sqlPlaceholders(postIds);
  return db
    .prepare(
      `SELECT post_id, reaction FROM post_reactions WHERE reactor_id = ? AND post_id IN (${placeholders})`,
    )
    .bind(reactorId, ...postIds);
}

/**
 * Returns reactorId's current reaction for each of postIds, in a single query
 * (no N+1). Used to render each post's reaction buttons in the correct state.
 */
export async function getViewerReactions(
  db: D1Database,
  reactorId: string,
  postIds: string[],
): Promise<Map<string, Reaction>> {
  if (postIds.length === 0) return new Map();
  const rows =
    (await viewerReactionsStmt(db, reactorId, postIds).all<{ post_id: string; reaction: Reaction }>())
      .results ?? [];
  return new Map(rows.map((r) => [r.post_id, r.reaction]));
}

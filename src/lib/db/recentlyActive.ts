/// <reference types="@cloudflare/workers-types" />
// Recently active forum participants: the DReps and SPOs who posted most
// recently. Powers the "Recently active on DRepTalk" list at the bottom of
// /discussions. Returns just the ordered author ids; callers hydrate identities
// via loadAuthorIdentities (avatar, name, role badges, profile link).

import { GOV_SYNC_AUTHOR } from '../governance/sync.js';

/**
 * Ordered author ids of the most recently active DReps/SPOs: users with a
 * governance role (is_drep or is_spo) who have authored a non-deleted,
 * non-hidden post in a non-deleted topic, ranked by their most recent such
 * post, newest first. Posts in deleted topics do not count, matching the rest
 * of the forum. Uses idx_posts_author (author_id, created_at). Limit clamped to [1, 50].
 */
/**
 * Counts the distinct recently active DReps/SPOs: the same population as
 * listRecentlyActiveAuthorIds, but bounded by a time window (ms) instead of a
 * row limit. Pairs with the capped list so a caller can say "and N more".
 */
export async function countRecentlyActiveAuthors(db: D1Database, sinceMs: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT u.id) AS n
       FROM users u
       JOIN posts p ON p.author_id = u.id
       JOIN topics t ON t.id = p.topic_id
       WHERE p.deleted = 0 AND p.hidden = 0
         AND t.deleted = 0
         AND (u.is_drep = 1 OR u.is_spo = 1)
         AND u.id <> ?
         AND p.created_at > ?`,
    )
    .bind(GOV_SYNC_AUTHOR, sinceMs)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listRecentlyActiveAuthorIds(db: D1Database, limit: number): Promise<string[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 0, 1), 50);
  const rows = (
    await db
      .prepare(
        `SELECT u.id
         FROM users u
         JOIN posts p ON p.author_id = u.id
         JOIN topics t ON t.id = p.topic_id
         WHERE p.deleted = 0 AND p.hidden = 0
           AND t.deleted = 0
           AND (u.is_drep = 1 OR u.is_spo = 1)
           AND u.id <> ?
         GROUP BY u.id
         ORDER BY MAX(p.created_at) DESC
         LIMIT ?`,
      )
      .bind(GOV_SYNC_AUTHOR, n)
      .all<{ id: string }>()
  ).results ?? [];
  return rows.map((r) => r.id);
}

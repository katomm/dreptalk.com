/// <reference types="@cloudflare/workers-types" />

import { sqlPlaceholders } from './sql.js';
import { rowToTopic, type Topic, type TopicRow } from './forum.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';

export interface TopicParticipant {
  authorId: string;
  posts: number;
}

export async function getTopicParticipants(
  db: D1Database,
  topicId: string,
  opts?: { limit?: number },
): Promise<TopicParticipant[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 100);
  const rows = (
    await db
      .prepare(
        `SELECT author_id, COUNT(*) AS posts
         FROM posts
         WHERE topic_id = ? AND deleted = 0 AND hidden = 0
         GROUP BY author_id
         ORDER BY posts DESC, MIN(created_at) ASC
         LIMIT ?`,
      )
      .bind(topicId, limit)
      .all<{ author_id: string; posts: number }>()
  ).results ?? [];
  return rows.map((r) => ({ authorId: r.author_id, posts: r.posts }));
}

export async function getParticipantCounts(
  db: D1Database,
  topicIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (topicIds.length === 0) return out;
  const CHUNK = 100;
  for (let i = 0; i < topicIds.length; i += CHUNK) {
    const chunk = topicIds.slice(i, i + CHUNK);
    const rows = (
      await db
        .prepare(
          // Exclude the governance-sync importer so a freshly imported action with
          // no human replies reads as 0 participants, not 1 (the auto-post author).
          `SELECT topic_id, COUNT(DISTINCT author_id) AS participants
           FROM posts
           WHERE topic_id IN (${sqlPlaceholders(chunk)}) AND deleted = 0 AND author_id <> ?
           GROUP BY topic_id`,
        )
        .bind(...chunk, GOV_SYNC_AUTHOR)
        .all<{ topic_id: string; participants: number }>()
    ).results ?? [];
    for (const r of rows) out.set(r.topic_id, r.participants);
  }
  return out;
}

export async function getTopicExcerpts(
  db: D1Database,
  topicIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (topicIds.length === 0) return out;
  const CHUNK = 100;
  for (let i = 0; i < topicIds.length; i += CHUNK) {
    const chunk = topicIds.slice(i, i + CHUNK);
    const rows = (
      await db
        .prepare(
          `SELECT topic_id, body_html, created_at
           FROM posts
           WHERE topic_id IN (${sqlPlaceholders(chunk)})
             AND parent_post_id IS NULL AND deleted = 0 AND hidden = 0
             AND (source IS NULL OR source != 'vote_rationale')
           ORDER BY topic_id, created_at ASC`,
        )
        .bind(...chunk)
        .all<{ topic_id: string; body_html: string; created_at: number }>()
    ).results ?? [];
    for (const r of rows) {
      if (!out.has(r.topic_id)) out.set(r.topic_id, r.body_html);
    }
  }
  return out;
}

export async function getRelatedTopics(
  db: D1Database,
  categorySlug: string,
  excludeTopicId: string,
  opts?: { limit?: number },
): Promise<Topic[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 20);
  const rows = (
    await db
      .prepare(
        `SELECT * FROM topics
         WHERE category_slug = ? AND id != ? AND deleted = 0
         ORDER BY last_post_at DESC
         LIMIT ?`,
      )
      .bind(categorySlug, excludeTopicId, limit)
      .all<TopicRow>()
  ).results ?? [];
  return rows.map(rowToTopic);
}

export type DiscussionSort = 'latest' | 'unanswered';

export const DISCUSSION_SORTS: readonly { key: DiscussionSort; label: string }[] = [
  { key: 'latest', label: 'All discussions' },
  { key: 'unanswered', label: 'Unanswered' },
];

export function parseDiscussionSort(v: string | null | undefined): DiscussionSort {
  return v === 'unanswered' ? 'unanswered' : 'latest';
}

/**
 * Returns non-deleted topics for a category, pinned first then by last activity.
 * The unanswered view restricts to topics with a single post (only the opening
 * post). limit clamped [1,100], default 30; offset >= 0.
 */
export async function getDiscussionTopics(
  db: D1Database,
  categorySlug: string,
  opts: { sort?: DiscussionSort; limit?: number; offset?: number },
): Promise<Topic[]> {
  const sort = opts.sort ?? 'latest';
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const where =
    sort === 'unanswered'
      ? 't.category_slug = ? AND t.deleted = 0 AND t.post_count = 1'
      : 't.category_slug = ? AND t.deleted = 0';

  const rows = (
    await db
      .prepare(
        `SELECT t.* FROM topics t WHERE ${where} ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(categorySlug, limit, offset)
      .all<TopicRow>()
  ).results ?? [];
  return rows.map(rowToTopic);
}

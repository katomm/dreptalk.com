/// <reference types="@cloudflare/workers-types" />

import { sqlPlaceholders } from './sql.js';
import { rowToTopic, type Topic, type TopicRow } from './forum.js';

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
          `SELECT topic_id, COUNT(DISTINCT author_id) AS participants
           FROM posts
           WHERE topic_id IN (${sqlPlaceholders(chunk)}) AND deleted = 0
           GROUP BY topic_id`,
        )
        .bind(...chunk)
        .all<{ topic_id: string; participants: number }>()
    ).results ?? [];
    for (const r of rows) out.set(r.topic_id, r.participants);
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

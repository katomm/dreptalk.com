/// <reference types="@cloudflare/workers-types" />

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

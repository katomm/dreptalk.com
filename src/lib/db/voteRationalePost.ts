/// <reference types="@cloudflare/workers-types" />
// The single frozen vote_rationale post per (author, governance-action topic).
// Re-voting updates the body + vote in place rather than adding a second post.
//
// Schema notes:
// - posts.id is TEXT PRIMARY KEY (UUID); generated on first insert.
// - posts.body_html is NOT NULL; stored as '' here because vote_rationale posts
//   are rendered from body_md on demand (Task 9) and never go through the normal
//   markdown pipeline at write time.
// - posts.source and posts.vote are nullable TEXT columns added in 0035_vote_casting.

export async function upsertVoteRationalePost(
  db: D1Database,
  rec: { topicId: string; authorId: string; gaId: string; vote: string; bodyMd: string; now: number },
): Promise<void> {
  const existing = await db
    .prepare(`SELECT id FROM posts WHERE topic_id = ? AND author_id = ? AND source = 'vote_rationale'`)
    .bind(rec.topicId, rec.authorId)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(`UPDATE posts SET body_md = ?, vote = ?, edited_at = ? WHERE id = ?`)
      .bind(rec.bodyMd, rec.vote, rec.now, existing.id)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at, source, vote)
       VALUES (?, ?, ?, ?, '', ?, 'vote_rationale', ?)`,
    )
    .bind(crypto.randomUUID(), rec.topicId, rec.authorId, rec.bodyMd, rec.now, rec.vote)
    .run();
}

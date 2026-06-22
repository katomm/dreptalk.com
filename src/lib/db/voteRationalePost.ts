/// <reference types="@cloudflare/workers-types" />
// The single frozen vote_rationale post per (author, governance-action topic).
// Re-voting updates the body + vote in place rather than adding a second post.
//
// Schema notes:
// - posts.id is TEXT PRIMARY KEY (UUID); generated on first insert.
// - posts.body_html is NOT NULL; caller renders markdown to sanitized HTML
//   and passes it in, matching the standard forum post pipeline.
// - posts.source and posts.vote are nullable TEXT columns added in 0035_vote_casting.

export async function upsertVoteRationalePost(
  db: D1Database,
  rec: { topicId: string; authorId: string; vote: string; bodyMd: string; bodyHtml: string; now: number },
): Promise<void> {
  const existing = await db
    .prepare(`SELECT id FROM posts WHERE topic_id = ? AND author_id = ? AND source = 'vote_rationale'`)
    .bind(rec.topicId, rec.authorId)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(`UPDATE posts SET body_md = ?, body_html = ?, vote = ?, edited_at = ? WHERE id = ?`)
      .bind(rec.bodyMd, rec.bodyHtml, rec.vote, rec.now, existing.id)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at, source, vote)
       VALUES (?, ?, ?, ?, ?, ?, 'vote_rationale', ?)`,
    )
    .bind(crypto.randomUUID(), rec.topicId, rec.authorId, rec.bodyMd, rec.bodyHtml, rec.now, rec.vote)
    .run();
}

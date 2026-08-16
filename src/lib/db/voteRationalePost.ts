/// <reference types="@cloudflare/workers-types" />
// The single frozen vote_rationale post per (author, governance-action topic).
// Re-voting updates the body + vote in place rather than adding a second post.
//
// Schema notes:
// - posts.id is TEXT PRIMARY KEY (UUID); generated on first insert.
// - posts.body_html is NOT NULL; caller renders markdown to sanitized HTML
//   and passes it in, matching the standard forum post pipeline.
// - posts.source and posts.vote are nullable TEXT columns added in 0035_vote_casting.
//
// A cross-post is counted exactly when it is shown. The INSERT branch bumps the
// topic's post_count and last_post_at like a normal reply. Re-voting on a still
// live post edits it in place and leaves the counter alone. Re-voting after the
// post was removed (opt-out, or migration 0046) revives it and re-increments the
// counter. removeVoteRationalePost undoes the count when a DRep re-votes with
// cross-posting turned off.
//
// The same lifecycle drives a reply_created activity event, so an opted-in
// cross-post shows in the "Latest activity" feed exactly like a normal reply:
// emitted on the INSERT and on revive, deleted again on opt-out, and left
// untouched on an in-place edit (so a re-vote does not churn the feed).

import { activityInsert } from './activity.js';

export async function upsertVoteRationalePost(
  db: D1Database,
  rec: { topicId: string; authorId: string; vote: string; bodyMd: string; bodyHtml: string; now: number },
): Promise<void> {
  const existing = await db
    .prepare(`SELECT id, deleted FROM posts WHERE topic_id = ? AND author_id = ? AND source = 'vote_rationale'`)
    .bind(rec.topicId, rec.authorId)
    .first<{ id: string; deleted: number }>();

  if (existing) {
    if (existing.deleted) {
      // Reviving a previously removed cross-post (opted out earlier, or removed
      // by the 0046 migration): bring it back into the thread AND re-count it, so
      // the "shown in the thread iff counted" invariant holds. deleted_at is
      // cleared with the flag, so the column never describes a state the row is
      // not in. The erasure sweep does not depend on that, it pairs each flag
      // with its own timestamp, but the next query written against this column
      // would.
      await db.batch([
        db
          .prepare(`UPDATE posts SET body_md = ?, body_html = ?, vote = ?, edited_at = ?, deleted = 0, deleted_at = NULL WHERE id = ?`)
          .bind(rec.bodyMd, rec.bodyHtml, rec.vote, rec.now, existing.id),
        db
          .prepare(`UPDATE topics SET post_count = post_count + 1, last_post_at = ? WHERE id = ?`)
          .bind(rec.now, rec.topicId),
        // The opt-out that removed it also deleted its feed event, so re-surface it.
        activityInsert(db, {
          type: 'reply_created',
          topicId: rec.topicId,
          actorId: rec.authorId,
          refPostId: existing.id,
          createdAt: rec.now,
        }),
      ]);
      return;
    }
    // In-place edit of a live, already counted post: leave the counter alone.
    await db
      .prepare(`UPDATE posts SET body_md = ?, body_html = ?, vote = ?, edited_at = ? WHERE id = ?`)
      .bind(rec.bodyMd, rec.bodyHtml, rec.vote, rec.now, existing.id)
      .run();
    return;
  }

  const postId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at, source, vote)
         VALUES (?, ?, ?, ?, ?, ?, 'vote_rationale', ?)`,
      )
      .bind(postId, rec.topicId, rec.authorId, rec.bodyMd, rec.bodyHtml, rec.now, rec.vote),
    db
      .prepare(`UPDATE topics SET post_count = post_count + 1, last_post_at = ? WHERE id = ?`)
      .bind(rec.now, rec.topicId),
    // Surface the opted-in cross-post in the activity feed, like a normal reply.
    activityInsert(db, {
      type: 'reply_created',
      topicId: rec.topicId,
      actorId: rec.authorId,
      refPostId: postId,
      createdAt: rec.now,
    }),
  ]);
}

// Soft-delete this author's frozen vote_rationale post from the topic's
// discussion, if a live one exists, and decrement the denormalized post_count to
// match. Used when a DRep re-votes with cross-posting turned off. The row is kept
// (deleted = 1) for audit; the rationale still lives on-chain and on the
// Positions tab (action_rationale).
export async function removeVoteRationalePost(
  db: D1Database,
  rec: { topicId: string; authorId: string; now: number },
): Promise<void> {
  const existing = await db
    .prepare(
      `SELECT id FROM posts
       WHERE topic_id = ? AND author_id = ? AND source = 'vote_rationale' AND deleted = 0`,
    )
    .bind(rec.topicId, rec.authorId)
    .first<{ id: string }>();
  if (!existing) return;
  await db.batch([
    db.prepare(`UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?`).bind(rec.now, existing.id),
    db.prepare(`UPDATE topics SET post_count = MAX(post_count - 1, 0) WHERE id = ?`).bind(rec.topicId),
    // Withdraw the feed event too; ref_post_id is unique to this cross-post.
    db.prepare(`DELETE FROM activity WHERE type = 'reply_created' AND ref_post_id = ?`).bind(existing.id),
  ]);
}

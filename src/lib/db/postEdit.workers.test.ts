/// <reference types="@cloudflare/workers-types" />
// editPost: grace-window silent edits vs. marked edits with archived revisions.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, editPost } from './forum.js';
import { EDIT_GRACE_MS } from '../forum/editPolicy.js';

const db = () => env.DB;
const NOW = 1_752_000_000_000;
const AUTHOR = 'drep-editor-1';

let seq = 0;
async function newTopicPost(): Promise<{ topicId: string; postId: string }> {
  seq++;
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general',
    authorId: AUTHOR,
    title: `Edit fixture ${seq}`,
    bodyMd: 'original body',
    bodyHtml: '<p>original body</p>',
    now: NOW,
    rand: `ed${seq}`,
  });
  return { topicId: topic.id, postId: firstPost.id };
}

// Reads body_md back (getPostById excludes it, so read the row directly).
async function readBody(postId: string): Promise<{ body_md: string; edited_at: number | null }> {
  const row = await db()
    .prepare('SELECT body_md, edited_at FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ body_md: string; edited_at: number | null }>();
  return row as { body_md: string; edited_at: number | null };
}

async function countRevisions(postId: string): Promise<number> {
  const row = await db()
    .prepare('SELECT COUNT(*) AS n FROM post_revisions WHERE post_id = ?')
    .bind(postId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('editPost: grace window', () => {
  it('edits silently within the grace window (no revision, edited_at stays null)', async () => {
    const { postId } = await newTopicPost();
    const res = await editPost(db(), {
      postId, authorId: AUTHOR, bodyMd: 'typo fixed', bodyHtml: '<p>typo fixed</p>',
      now: NOW + 60_000, // 1 minute later
    });
    expect(res.edited).toBe(false);
    const body = await readBody(postId);
    expect(body.body_md).toBe('typo fixed');
    expect(body.edited_at).toBeNull();
    expect(await countRevisions(postId)).toBe(0);
  });

  it('archives a revision and sets edited_at after the grace window', async () => {
    const { postId } = await newTopicPost();
    const res = await editPost(db(), {
      postId, authorId: AUTHOR, bodyMd: 'rewritten', bodyHtml: '<p>rewritten</p>',
      now: NOW + EDIT_GRACE_MS + 1,
    });
    expect(res.edited).toBe(true);
    const body = await readBody(postId);
    expect(body.body_md).toBe('rewritten');
    expect(body.edited_at).toBe(NOW + EDIT_GRACE_MS + 1);
    expect(await countRevisions(postId)).toBe(1);
    // The archived revision holds the PRIOR body, not the new one.
    const rev = await db()
      .prepare('SELECT body_md, editor_id, replaced_at FROM post_revisions WHERE post_id = ?')
      .bind(postId)
      .first<{ body_md: string; editor_id: string; replaced_at: number }>();
    expect(rev?.body_md).toBe('original body');
    expect(rev?.editor_id).toBe(AUTHOR);
    expect(rev?.replaced_at).toBe(NOW + EDIT_GRACE_MS + 1);
  });
});

describe('editPost: authorization and state', () => {
  it('throws not_owner when editing someone else\'s post', async () => {
    const { postId } = await newTopicPost();
    await expect(
      editPost(db(), { postId, authorId: 'other-drep', bodyMd: 'x', bodyHtml: '<p>x</p>', now: NOW + EDIT_GRACE_MS + 1 }),
    ).rejects.toThrow('not_owner');
  });

  it('throws post_not_found for a missing post', async () => {
    await expect(
      editPost(db(), { postId: crypto.randomUUID(), authorId: AUTHOR, bodyMd: 'x', bodyHtml: '<p>x</p>', now: NOW }),
    ).rejects.toThrow('post_not_found');
  });

  it('throws topic_locked when the topic is locked', async () => {
    const { topicId, postId } = await newTopicPost();
    await db().prepare('UPDATE topics SET locked = 1 WHERE id = ?').bind(topicId).run();
    await expect(
      editPost(db(), { postId, authorId: AUTHOR, bodyMd: 'x', bodyHtml: '<p>x</p>', now: NOW + EDIT_GRACE_MS + 1 }),
    ).rejects.toThrow('topic_locked');
  });

  it('throws post_hidden when the post is hidden by the community', async () => {
    const { postId } = await newTopicPost();
    await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(postId).run();
    await expect(
      editPost(db(), { postId, authorId: AUTHOR, bodyMd: 'x', bodyHtml: '<p>x</p>', now: NOW + EDIT_GRACE_MS + 1 }),
    ).rejects.toThrow('post_hidden');
  });
});

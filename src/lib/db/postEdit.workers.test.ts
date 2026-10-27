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
async function newTopicPost(proposerGrantId?: string | null): Promise<{ topicId: string; postId: string }> {
  seq++;
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general',
    authorId: AUTHOR,
    title: `Edit fixture ${seq}`,
    bodyMd: 'original body',
    bodyHtml: '<p>original body</p>',
    now: NOW,
    rand: `ed${seq}`,
    proposerGrantId,
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

// A real grant row for the stamped-row cases: editPost/editTitle check the
// stored grant in D1, so a bare id with no row counts as inactive.
async function insertGrant(id: string, coUserId: string, n: number, status: 'active' | 'revoked' = 'active') {
  await db()
    .prepare(
      `INSERT INTO proposer_grants
         (id, proposer_user_id, proposer_stake_addr, gov_action_id, co_user_id, co_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at)
       VALUES (?1, 'proposer-user', 'stake_test1editproposer', ?2, ?3, ?4, ?1, ?5, 0, 604800, 0)`,
    )
    .bind(id, `${'9e'.repeat(31)}${String(n).padStart(2, '0')}#0`, coUserId, `stake_test1co${coUserId}`, status)
    .run();
}

describe('editPost: grace window', () => {
  it('edits silently within the grace window (no revision, edited_at stays null)', async () => {
    const { postId } = await newTopicPost();
    const res = await editPost(db(), {
      postId, authorId: AUTHOR, bodyMd: 'typo fixed', bodyHtml: '<p>typo fixed</p>',
      now: NOW + 60_000, // 1 minute later
      ownWriter: true,
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
      ownWriter: true,
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
      editPost(db(), { postId, authorId: 'other-drep', bodyMd: 'x', bodyHtml: '<p>x</p>', now: NOW + EDIT_GRACE_MS + 1, ownWriter: true }),
    ).rejects.toThrow('not_owner');
  });

  it('throws post_not_found for a missing post', async () => {
    await expect(
      editPost(db(), { postId: crypto.randomUUID(), authorId: AUTHOR, bodyMd: 'x', bodyHtml: '<p>x</p>', now: NOW, ownWriter: true }),
    ).rejects.toThrow('post_not_found');
  });

  it('throws topic_locked when the topic is locked', async () => {
    const { topicId, postId } = await newTopicPost();
    await db().prepare('UPDATE topics SET locked = 1 WHERE id = ?').bind(topicId).run();
    await expect(
      editPost(db(), { postId, authorId: AUTHOR, bodyMd: 'x', bodyHtml: '<p>x</p>', now: NOW + EDIT_GRACE_MS + 1, ownWriter: true }),
    ).rejects.toThrow('topic_locked');
  });

  it('throws post_hidden when the post is hidden by the community', async () => {
    const { postId } = await newTopicPost();
    await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(postId).run();
    await expect(
      editPost(db(), { postId, authorId: AUTHOR, bodyMd: 'x', bodyHtml: '<p>x</p>', now: NOW + EDIT_GRACE_MS + 1, ownWriter: true }),
    ).rejects.toThrow('post_hidden');
  });
});

describe('editPost: stamped grant', () => {
  const edit = (postId: string, ownWriter: boolean, bodyMd = 'x') =>
    editPost(db(), {
      postId, authorId: AUTHOR, bodyMd, bodyHtml: `<p>${bodyMd}</p>`, now: NOW + EDIT_GRACE_MS + 1, ownWriter,
    });

  it('edits a stamped post while exactly its grant is active for the author, without an own writer role', async () => {
    await insertGrant('pe-grant-active', AUTHOR, 1);
    const { postId } = await newTopicPost('pe-grant-active');
    const res = await edit(postId, false, 'updated by mandate');
    expect(res.edited).toBe(true);
    const row = await db()
      .prepare('SELECT body_md, proposer_grant_id FROM posts WHERE id = ?')
      .bind(postId)
      .first<{ body_md: string; proposer_grant_id: string | null }>();
    expect(row?.body_md).toBe('updated by mandate');
    expect(row?.proposer_grant_id).toBe('pe-grant-active');
  });

  it('throws mandate_mismatch on a stamped post whose grant was revoked, even for an own writer', async () => {
    await insertGrant('pe-grant-revoked', AUTHOR, 2, 'revoked');
    const { postId } = await newTopicPost('pe-grant-revoked');
    await expect(edit(postId, true)).rejects.toThrow('mandate_mismatch');
  });

  it('throws mandate_mismatch on a stamped post whose grant belongs to someone else', async () => {
    await insertGrant('pe-grant-foreign', 'someone-else', 3);
    const { postId } = await newTopicPost('pe-grant-foreign');
    await expect(edit(postId, true)).rejects.toThrow('mandate_mismatch');
  });

  it('throws mandate_mismatch on an unstamped post without an own writer role', async () => {
    const { postId } = await newTopicPost(null);
    await expect(edit(postId, false)).rejects.toThrow('mandate_mismatch');
  });
});

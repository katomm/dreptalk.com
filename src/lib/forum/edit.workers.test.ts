// src/lib/forum/edit.workers.test.ts
/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from '../db/forum.js';
import { upsertVoteRationalePost } from '../db/voteRationalePost.js';
import { handleEditPost, handleEditTitle } from './handlers.js';
import { EDIT_GRACE_MS } from './editPolicy.js';

const db = () => env.DB;
const rateLimiter = () => env.RATE_LIMITER;
const NOW = 1_752_000_000_000;
const AUTHOR = { id: 'drep-edit-h-1', roles: ['drep'] };

let seq = 0;
async function fixture(source: 'user' | 'governance' = 'user') {
  seq++;
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: AUTHOR.id, title: `Edit handler ${seq}`,
    bodyMd: 'orig', bodyHtml: '<p>orig</p>', source, now: NOW, rand: `eh${seq}`,
  });
  return { topicId: topic.id, postId: firstPost.id };
}
const postInput = (user: typeof AUTHOR | null, postId: string, bodyMd: unknown) =>
  ({ user, postId, body: { bodyMd }, db: db(), rateLimiter: rateLimiter(), now: NOW + EDIT_GRACE_MS + 5 });
const titleInput = (user: typeof AUTHOR | null, topicId: string, title: unknown) =>
  ({ user, topicId, body: { title }, db: db(), rateLimiter: rateLimiter(), now: NOW + 5 });

// Inserts a proposer_grants row directly (bypassing the invite/redeem flow,
// which is exercised elsewhere) so this test can set up a revoked grant.
async function insertGrant(args: { id: string; proposerUserId: string; coUserId: string; status: 'active' | 'revoked' }) {
  await db()
    .prepare(
      `INSERT INTO proposer_grants
         (id, proposer_user_id, proposer_stake_addr, co_user_id, co_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at, revoked_at)
       VALUES (?1, ?2, 'stake_test1editproposer', ?3, 'stake_test1editco', ?1, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      args.id,
      args.proposerUserId,
      args.coUserId,
      args.status,
      NOW,
      NOW + 604800,
      args.status === 'active' ? NOW : null,
      args.status === 'revoked' ? NOW : null,
    )
    .run();
}

describe('handleEditPost', () => {
  it('401 when unauthenticated', async () => {
    const { postId } = await fixture();
    expect((await handleEditPost(postInput(null, postId, 'new'))).status).toBe(401);
  });
  it('403 for a non-writer', async () => {
    const { postId } = await fixture();
    const r = await handleEditPost(postInput({ id: 'm', roles: ['member'] } as never, postId, 'new'));
    expect(r.status).toBe(403);
  });
  it('400 for an empty body', async () => {
    const { postId } = await fixture();
    expect((await handleEditPost(postInput(AUTHOR, postId, '   '))).status).toBe(400);
  });
  it('403 (not_owner) editing another writer\'s post', async () => {
    const { postId } = await fixture();
    const r = await handleEditPost(postInput({ id: 'other', roles: ['drep'] }, postId, 'new'));
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('not_owner');
  });
  it('200 and re-rendered HTML on a valid edit', async () => {
    const { postId } = await fixture();
    const r = await handleEditPost(postInput(AUTHOR, postId, '**bold**'));
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    const row = await db().prepare('SELECT body_html FROM posts WHERE id = ?').bind(postId)
      .first<{ body_html: string }>();
    expect(row?.body_html).toContain('<strong>bold</strong>');
  });

  it('403 (frozen) editing a vote_rationale post is rejected', async () => {
    // Seed a governance topic and a vote_rationale post directly.
    const { topic } = await createTopic(db(), {
      categorySlug: 'general', authorId: AUTHOR.id, title: `Frozen rationale ${++seq}`,
      bodyMd: 'gov', bodyHtml: '<p>gov</p>', source: 'governance', now: NOW, rand: `fr${seq}`,
    });
    await upsertVoteRationalePost(db(), {
      topicId: topic.id, authorId: AUTHOR.id, vote: 'yes',
      bodyMd: 'rationale text', bodyHtml: '<p>rationale text</p>', now: NOW,
    });
    const frozen = await db()
      .prepare(`SELECT id FROM posts WHERE topic_id = ? AND author_id = ? AND source = 'vote_rationale'`)
      .bind(topic.id, AUTHOR.id)
      .first<{ id: string }>();
    const r = await handleEditPost(postInput(AUTHOR, frozen!.id, 'tampered'));
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('frozen_rationale');
  });

  it('200 on a normal (source=null) post is unaffected', async () => {
    const { postId } = await fixture('user');
    const r = await handleEditPost(postInput(AUTHOR, postId, 'updated text'));
    expect(r.status).toBe(200);
  });

  it('403 mandate revoked when the editor\'s grant was revoked', async () => {
    const coUserId = 'grant-co-user-edit-post';
    await insertGrant({ id: 'grant-edit-post-1', proposerUserId: 'proposer-user-1', coUserId, status: 'revoked' });
    const { postId } = await fixture();
    const user = { id: coUserId, roles: ['proposer'], grantId: 'grant-edit-post-1' };
    const r = await handleEditPost({
      user, postId, body: { bodyMd: 'should not land' }, db: db(), rateLimiter: rateLimiter(), now: NOW + EDIT_GRACE_MS + 5,
    });
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('mandate revoked');
  });
});

describe('handleEditTitle', () => {
  it('200 updates the title for the author', async () => {
    const { topicId } = await fixture();
    const r = await handleEditTitle(titleInput(AUTHOR, topicId, 'Sharper title'));
    expect(r.status).toBe(200);
  });
  it('400 for a too-short title', async () => {
    const { topicId } = await fixture();
    expect((await handleEditTitle(titleInput(AUTHOR, topicId, 'ab'))).status).toBe(400);
  });
  it('403 (not_user_topic) for a governance topic', async () => {
    const { topicId } = await fixture('governance');
    const r = await handleEditTitle(titleInput(AUTHOR, topicId, 'Sharper title'));
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('not_user_topic');
  });
});

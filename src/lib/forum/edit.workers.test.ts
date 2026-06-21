// src/lib/forum/edit.workers.test.ts
/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from '../db/forum.js';
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

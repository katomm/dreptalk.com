// src/lib/db/postHistory.workers.test.ts
/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, editPost, getPostHistory } from './forum.js';
import { EDIT_GRACE_MS } from '../forum/editPolicy.js';

const db = () => env.DB;
const NOW = 1_752_000_000_000;
const AUTHOR = 'drep-hist-1';

let seq = 0;
async function newPost(now: number = NOW): Promise<string> {
  seq++;
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: AUTHOR, title: `Hist fixture ${seq}`,
    bodyMd: 'v0', bodyHtml: '<p>v0</p>', now, rand: `hi${seq}`,
  });
  return firstPost.id;
}

describe('getPostHistory', () => {
  it('returns null for a missing post', async () => {
    expect(await getPostHistory(db(), crypto.randomUUID())).toBeNull();
  });

  it('returns just the current version for a never-edited post', async () => {
    const postId = await newPost();
    const h = await getPostHistory(db(), postId);
    expect(h?.versions).toHaveLength(1);
    expect(h?.versions[0]).toMatchObject({ bodyMd: 'v0', current: true, createdAt: NOW });
    expect(h?.topicTitle).toContain('Hist fixture');
    expect(h?.hidden).toBe(false);
  });

  it('returns current + revisions newest-first after marked edits', async () => {
    const postId = await newPost();
    await editPost(db(), { postId, authorId: AUTHOR, bodyMd: 'v1', bodyHtml: '<p>v1</p>', now: NOW + EDIT_GRACE_MS + 10, sessionGrantId: null });
    await editPost(db(), { postId, authorId: AUTHOR, bodyMd: 'v2', bodyHtml: '<p>v2</p>', now: NOW + EDIT_GRACE_MS + 20, sessionGrantId: null });
    const h = await getPostHistory(db(), postId);
    expect(h?.versions.map((v) => v.bodyMd)).toEqual(['v2', 'v1', 'v0']);
    expect(h?.versions[0].current).toBe(true);
    expect(h?.versions[1].current).toBe(false);
    expect(h?.versions[0].createdAt).toBe(NOW + EDIT_GRACE_MS + 20);
  });

  it('reports when each version was created, not when it was replaced', async () => {
    const t0 = NOW;
    const t1 = t0 + EDIT_GRACE_MS + 10;
    const t2 = t1 + 1000;

    const postId = await newPost(t0);
    await editPost(db(), { postId, authorId: AUTHOR, bodyMd: 'v2', bodyHtml: '<p>v2</p>', now: t1, sessionGrantId: null });
    await editPost(db(), { postId, authorId: AUTHOR, bodyMd: 'v3', bodyHtml: '<p>v3</p>', now: t2, sessionGrantId: null });

    const h = await getPostHistory(db(), postId);
    expect(h?.versions.map((v) => v.createdAt)).toEqual([t2, t1, t0]);
  });

  it('returns null for a live post inside a deleted topic', async () => {
    const postId = await newPost();
    const { topic_id: topicId } = (await db()
      .prepare('SELECT topic_id FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as { topic_id: string };
    await db().prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(topicId).run();

    expect(await getPostHistory(db(), postId)).toBeNull();
  });

  it('reports created_at for a post that was never edited', async () => {
    const postId = await newPost(NOW);
    const h = await getPostHistory(db(), postId);
    expect(h?.versions).toHaveLength(1);
    expect(h?.versions[0].createdAt).toBe(NOW);
  });
});

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
async function newPost(): Promise<string> {
  seq++;
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: AUTHOR, title: `Hist fixture ${seq}`,
    bodyMd: 'v0', bodyHtml: '<p>v0</p>', now: NOW, rand: `hi${seq}`,
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
    expect(h?.versions[0]).toMatchObject({ bodyMd: 'v0', current: true, at: NOW });
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
    expect(h?.versions[0].at).toBe(NOW + EDIT_GRACE_MS + 20);
  });
});

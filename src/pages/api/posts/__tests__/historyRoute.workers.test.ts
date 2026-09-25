/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for GET /api/posts/[id]/history. getPostHistory itself
// is covered in src/lib/db/postHistory.workers.test.ts, here we drive the real
// route and assert its hidden-post gate (author and moderators only).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from '@/lib/db/forum';
import { GET } from '../[id]/history';

const NOW = 1_752_000_000_000;

let seq = 0;
async function newPost(authorId: string, hidden: boolean): Promise<string> {
  seq++;
  const { firstPost } = await createTopic(env.DB, {
    categorySlug: 'general', authorId, title: `Hist route ${seq}`,
    bodyMd: 'b', bodyHtml: '<p>b</p>', now: NOW, rand: `hr${seq}`,
  });
  if (hidden) {
    await env.DB.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(firstPost.id).run();
  }
  return firstPost.id;
}

function callGet(postId: string, user: { id: string; roles: string[] } | null) {
  const request = new Request(`https://dreptalk.com/api/posts/${postId}/history`);
  const locals = { user } as unknown as App.Locals;
  return GET({ request, locals, params: { id: postId } } as unknown as Parameters<typeof GET>[0]);
}

describe('GET /api/posts/[id]/history', () => {
  it('serves a visible post to an anonymous viewer', async () => {
    const postId = await newPost('drep-a', false);
    const res = await callGet(postId, null);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; versions: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.versions.length).toBeGreaterThan(0);
  });

  it.each([
    ['an anonymous viewer', null],
    ['another writer', { id: 'drep-b', roles: ['drep'] }],
  ])('answers 404 for a hidden post to %s', async (_label, user) => {
    const postId = await newPost('drep-a', true);
    const res = await callGet(postId, user);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'post_not_found' });
  });

  it.each([
    ['its author', { id: 'drep-a', roles: ['drep'] }],
    ['a moderator', { id: 'mod-1', roles: ['moderator'] }],
  ])('serves a hidden post to %s', async (_label, user) => {
    const postId = await newPost('drep-a', true);
    const res = await callGet(postId, user);
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });
});

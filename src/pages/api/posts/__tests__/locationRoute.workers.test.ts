/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for GET /api/posts/[id]/location. getPostLocation itself
// is covered in src/lib/db/forum.workers.test.ts, here we drive the real route.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from '@/lib/db/forum';
import { GET } from '../[id]/location';

const NOW = 1_752_100_000_000;

function callGet(postId: string) {
  const request = new Request(`https://dreptalk.com/api/posts/${postId}/location`);
  const locals = { user: null } as unknown as App.Locals;
  return GET({ request, locals, params: { id: postId } } as unknown as Parameters<typeof GET>[0]);
}

describe('GET /api/posts/[id]/location', () => {
  it('answers with topic, tab and page for a live post', async () => {
    const { topic, firstPost } = await createTopic(env.DB, {
      categorySlug: 'general', authorId: 'drep-loc', title: 'Location route',
      bodyMd: 'b', bodyHtml: '<p>b</p>', now: NOW, rand: 'lr1',
    });
    const res = await callGet(firstPost.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, topicSlug: topic.slug, tab: null, page: 1 });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('is a 404 for an unknown post', async () => {
    const res = await callGet('no-such-post');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'post_not_found' });
  });

  it('is a 404 for an overlong id without asking the database', async () => {
    const res = await callGet('x'.repeat(200));
    expect(res.status).toBe(404);
  });
});

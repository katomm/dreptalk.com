import { describe, it, expect, vi } from 'vitest';
import { submitComposer } from './composer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake fetch that returns a fixed status + JSON body. */
function fakeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    ok: status >= 200 && status < 300,
  } as Response);
}

// ---------------------------------------------------------------------------
// mode: 'topic' - happy path
// ---------------------------------------------------------------------------

describe('submitComposer: topic mode, happy path', () => {
  it('POSTs to /api/topics with the correct body and returns ok + slug', async () => {
    const fetch = fakeFetch(201, { ok: true, slug: 'my-topic-ab1234' });

    const result = await submitComposer({
      mode: 'topic',
      payload: {
        categorySlug: 'general',
        title: 'My test topic',
        bodyMd: 'Hello world',
      },
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.slug).toBe('my-topic-ab1234');
    expect(result.error).toBeUndefined();

    // Verify URL and method.
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/topics');
    expect(init.method).toBe('POST');

    // Verify request body includes all three fields.
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.categorySlug).toBe('general');
    expect(sentBody.title).toBe('My test topic');
    expect(sentBody.bodyMd).toBe('Hello world');
  });
});

// ---------------------------------------------------------------------------
// mode: 'post' - happy path
// ---------------------------------------------------------------------------

describe('submitComposer: post mode, happy path', () => {
  it('POSTs to /api/topics/<id>/posts with bodyMd and returns ok + postId', async () => {
    const fetch = fakeFetch(201, { ok: true, postId: 'post-uuid-9' });

    const result = await submitComposer({
      mode: 'post',
      payload: {
        topicId: 'topic-uuid-001',
        bodyMd: '**reply text**',
      },
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.slug).toBeUndefined();
    expect(result.postId).toBe('post-uuid-9');
    expect(result.error).toBeUndefined();

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/topics/topic-uuid-001/posts');
    expect(init.method).toBe('POST');

    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.bodyMd).toBe('**reply text**');
    expect(sentBody.parentPostId).toBeUndefined();
  });

  it('sends parentPostId when replying to a specific post', async () => {
    const fetch = fakeFetch(201, { ok: true, postId: 'post-uuid-10' });

    await submitComposer({
      mode: 'post',
      payload: {
        topicId: 'topic-uuid-001',
        bodyMd: 'nested reply',
        parentPostId: 'parent-uuid-1',
      },
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.parentPostId).toBe('parent-uuid-1');
  });
});

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

describe('submitComposer: 401 unauthorized', () => {
  it('returns ok:false with the server error message', async () => {
    const fetch = fakeFetch(401, { ok: false, error: 'unauthorized' });

    const result = await submitComposer({
      mode: 'topic',
      payload: { categorySlug: 'general', title: 'X', bodyMd: 'body' },
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('unauthorized');
  });
});

describe('submitComposer: 400 bad request', () => {
  it('returns ok:false with the server error message', async () => {
    const fetch = fakeFetch(400, { ok: false, error: 'title must be 3 to 200 characters' });

    const result = await submitComposer({
      mode: 'topic',
      payload: { categorySlug: 'general', title: 'ab', bodyMd: 'body' },
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('title must be 3 to 200 characters');
  });
});

describe('submitComposer: 429 rate limited', () => {
  it('returns ok:false with rate_limited error', async () => {
    const fetch = fakeFetch(429, { ok: false, error: 'rate_limited' });

    const result = await submitComposer({
      mode: 'post',
      payload: { topicId: 'tid', bodyMd: 'body' },
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('rate_limited');
  });
});

describe('submitComposer: 500 with unparseable body', () => {
  it('returns ok:false with a fallback error message when body is not JSON', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 500,
      json: async () => { throw new Error('invalid json'); },
      ok: false,
    } as unknown as Response);

    const result = await submitComposer({
      mode: 'topic',
      payload: { categorySlug: 'general', title: 'Test', bodyMd: 'body' },
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500/);
  });
});

// ---------------------------------------------------------------------------
// Network error
// ---------------------------------------------------------------------------

describe('submitComposer: network error', () => {
  it('returns ok:false when fetch throws', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    const result = await submitComposer({
      mode: 'topic',
      payload: { categorySlug: 'general', title: 'Test', bodyMd: 'body' },
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Failed to fetch');
  });
});

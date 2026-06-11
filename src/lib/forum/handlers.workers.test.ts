/// <reference types="@cloudflare/workers-types" />
// Handler tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Tests handleCreateTopic and handleCreatePost with real D1/KV bindings
// and injected fake user objects. No actual HTTP requests are made.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, getTopicBySlug } from '../db/forum.js';
import { handleCreateTopic, handleCreatePost } from './handlers.js';

// Stable fake user with a real on-chain writer role (drep). 'writer' is not a
// real role; posting is gated by isWriter() which only accepts drep/spo/cc/proposer.
const WRITER = { id: 'user-writer-001', roles: ['drep'] };

// Shared DB and rate-limiter accessors.
const db = () => env.DB;
const rateLimiter = () => env.RATE_LIMITER;

// Fixed timestamp to keep tests deterministic.
const NOW = 1_750_000_000_000;

// ---------------------------------------------------------------------------
// Posting works for every on-chain writer role (drep, spo, cc, proposer)
// ---------------------------------------------------------------------------

describe('posting works for each writer role', () => {
  const roles = ['drep', 'spo', 'cc', 'proposer'] as const;

  for (const role of roles) {
    it(`a ${role} can create a topic and reply to it`, async () => {
      const user = { id: `writer-${role}-001`, roles: [role] };

      const topicRes = await handleCreateTopic({
        user,
        body: { categorySlug: 'general', title: `Hello from a ${role}`, bodyMd: `A post by a ${role}.` },
        db: db(),
        rateLimiter: rateLimiter(),
        now: NOW,
      });
      expect(topicRes.status).toBe(201);
      const { slug } = topicRes.json as { ok: boolean; slug: string };

      const topicRow = await db().prepare('SELECT id FROM topics WHERE slug = ?').bind(slug).first<{ id: string }>();
      expect(topicRow).not.toBeNull();

      const replyRes = await handleCreatePost({
        user,
        topicId: topicRow!.id,
        body: { bodyMd: `A reply by a ${role}.` },
        db: db(),
        rateLimiter: rateLimiter(),
        now: NOW + 1,
      });
      expect(replyRes.status).toBe(201);
    });
  }

  it('an unauthenticated request cannot create a topic', async () => {
    const res = await handleCreateTopic({
      user: null,
      body: { categorySlug: 'general', title: 'Should be blocked', bodyMd: 'nope' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(401);
  });

  it('a non-writer authenticated user (moderator-only) cannot create a topic', async () => {
    const res = await handleCreateTopic({
      user: { id: 'mod-only-user', roles: ['moderator'] },
      body: { categorySlug: 'general', title: 'Mod tries to post', bodyMd: 'should be 403' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(403);
  });

  it('a non-writer authenticated user (member) cannot reply', async () => {
    // Create a topic first as a writer.
    const topicRes = await handleCreateTopic({
      user: { id: 'writer-for-reply-gate', roles: ['drep'] },
      body: { categorySlug: 'general', title: 'Topic for reply gate test', bodyMd: 'body' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    const { slug } = topicRes.json as { slug: string };
    const topicRow = await db().prepare('SELECT id FROM topics WHERE slug = ?').bind(slug).first<{ id: string }>();

    const res = await handleCreatePost({
      user: { id: 'member-only-user', roles: ['member'] },
      topicId: topicRow!.id,
      body: { bodyMd: 'member should not reply' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// handleCreateTopic
// ---------------------------------------------------------------------------

describe('handleCreateTopic: happy path', () => {
  it('returns 201 with a slug and creates the topic in DB', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: {
        categorySlug: 'general',
        title: 'My Test Topic',
        bodyMd: '**hello world**',
      },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });

    expect(result.status).toBe(201);
    const json = result.json as { ok: boolean; slug: string };
    expect(json.ok).toBe(true);
    expect(typeof json.slug).toBe('string');
    expect(json.slug.length).toBeGreaterThan(0);

    // Topic must exist in DB.
    const topic = await getTopicBySlug(db(), json.slug);
    expect(topic).not.toBeNull();
    expect(topic!.title).toBe('My Test Topic');
    expect(topic!.author_id).toBe(WRITER.id);
    expect(topic!.category_slug).toBe('general');
  });

  it('stores sanitized body_html (script tags stripped)', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: {
        categorySlug: 'general',
        title: 'XSS Topic',
        bodyMd: 'safe text <script>alert(1)</script> more text',
      },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });

    expect(result.status).toBe(201);
    const json = result.json as { ok: boolean; slug: string };

    // Read back the first post's body_html directly from DB.
    const topicRow = await db()
      .prepare('SELECT id FROM topics WHERE slug = ?')
      .bind(json.slug)
      .first<{ id: string }>();
    expect(topicRow).not.toBeNull();

    const postRow = await db()
      .prepare('SELECT body_html FROM posts WHERE topic_id = ? ORDER BY created_at ASC LIMIT 1')
      .bind(topicRow!.id)
      .first<{ body_html: string }>();
    expect(postRow).not.toBeNull();
    expect(postRow!.body_html).not.toContain('<script');
    expect(postRow!.body_html).toContain('safe text');
  });
});

describe('handleCreateTopic: authorization', () => {
  it('returns 401 when user is null', async () => {
    const result = await handleCreateTopic({
      user: null,
      body: { categorySlug: 'general', title: 'Test', bodyMd: 'body' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(401);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('unauthorized');
  });
});

describe('handleCreateTopic: category rules', () => {
  it('returns 400 for an unknown category slug', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'does-not-exist', title: 'Test Topic', bodyMd: 'body' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(400);
  });

  it('returns 403 for the governance category', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'governance-actions', title: 'Governance Post', bodyMd: 'body' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(403);
    const json = result.json as { ok: boolean; error: string };
    expect(json.error).toBe('cannot post in this category');
  });
});

describe('handleCreateTopic: title validation', () => {
  it('returns 400 when title is too short (< 3 chars)', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'general', title: 'ab', bodyMd: 'body text' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(400);
  });

  it('returns 400 when title is too long (> 200 chars)', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'general', title: 'a'.repeat(201), bodyMd: 'body text' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(400);
  });

  it('accepts a title of exactly 3 chars', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'general', title: 'abc', bodyMd: 'body text' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 2,
    });
    expect(result.status).toBe(201);
  });

  it('accepts a title of exactly 200 chars', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'general', title: 'a'.repeat(200), bodyMd: 'body text' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 3,
    });
    expect(result.status).toBe(201);
  });
});

describe('handleCreateTopic: body validation', () => {
  it('returns 400 when bodyMd is empty', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'general', title: 'Valid Title', bodyMd: '' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(400);
  });

  it('returns 400 when bodyMd exceeds 20000 chars', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'general', title: 'Valid Title', bodyMd: 'x'.repeat(20001) },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(400);
  });

  it('accepts bodyMd of exactly 20000 chars', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'general', title: 'Max Body', bodyMd: 'x'.repeat(20000) },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 4,
    });
    expect(result.status).toBe(201);
  });
});

describe('handleCreateTopic: rate limiting', () => {
  it('returns 429 on the 6th topic creation within 600s window', async () => {
    // Use a unique user ID so this test does not share state with others.
    const rateUser = { id: `rate-topic-user-${Date.now()}`, roles: ['drep'] };

    const makeReq = (n: number) =>
      handleCreateTopic({
        user: rateUser,
        body: {
          categorySlug: 'general',
          title: `Rate Test Topic ${n}`,
          bodyMd: 'some body text',
        },
        db: db(),
        rateLimiter: rateLimiter(),
        now: NOW + n,
      });

    // 5 allowed.
    for (let i = 1; i <= 5; i++) {
      const r = await makeReq(i);
      expect(r.status, `request ${i} should be 201`).toBe(201);
    }

    // 6th denied.
    const denied = await makeReq(6);
    expect(denied.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// handleCreatePost
// ---------------------------------------------------------------------------

describe('handleCreatePost: happy path', () => {
  it('returns 201 and increments post_count on the topic', async () => {
    // Create a topic to reply to.
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: WRITER.id,
      title: 'Topic for Reply',
      bodyMd: 'original body',
      bodyHtml: '<p>original body</p>',
      now: NOW,
      rand: 'reply-test-001',
    });

    const result = await handleCreatePost({
      user: WRITER,
      topicId: topic.id,
      body: { bodyMd: '**reply text**' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1000,
    });

    expect(result.status).toBe(201);
    const json = result.json as { ok: boolean; postId: string };
    expect(json.ok).toBe(true);
    // The new post's id comes back so the client can scroll to it.
    expect(typeof json.postId).toBe('string');

    // post_count must be 2 now (original + reply).
    const updated = await getTopicBySlug(db(), topic.slug);
    expect(updated!.post_count).toBe(2);
  });
});

describe('handleCreatePost: authorization', () => {
  it('returns 401 when user is null', async () => {
    const result = await handleCreatePost({
      user: null,
      topicId: 'any-topic-id',
      body: { bodyMd: 'reply' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(401);
    const json = result.json as { ok: boolean; error: string };
    expect(json.error).toBe('unauthorized');
  });
});

describe('handleCreatePost: topic state errors', () => {
  it('returns 403 when the topic is locked', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: WRITER.id,
      title: 'Locked Topic Handler',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: NOW,
      rand: 'locked-handler-001',
    });

    await db()
      .prepare('UPDATE topics SET locked = 1 WHERE id = ?')
      .bind(topic.id)
      .run();

    const result = await handleCreatePost({
      user: WRITER,
      topicId: topic.id,
      body: { bodyMd: 'reply to locked' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });

    expect(result.status).toBe(403);
  });

  it('returns 404 when the topic does not exist', async () => {
    const result = await handleCreatePost({
      user: WRITER,
      topicId: 'non-existent-topic-id-xyz',
      body: { bodyMd: 'reply to nothing' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(404);
  });
});

describe('handleCreatePost: body validation', () => {
  it('returns 400 when bodyMd is empty', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: WRITER.id,
      title: 'Topic for Empty Reply',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: NOW,
      rand: 'empty-reply-001',
    });

    const result = await handleCreatePost({
      user: WRITER,
      topicId: topic.id,
      body: { bodyMd: '' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });
    expect(result.status).toBe(400);
  });

  it('returns 400 when bodyMd exceeds 20000 chars', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: WRITER.id,
      title: 'Topic for Oversized Reply',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: NOW,
      rand: 'oversized-reply-001',
    });

    const result = await handleCreatePost({
      user: WRITER,
      topicId: topic.id,
      body: { bodyMd: 'x'.repeat(20001) },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });
    expect(result.status).toBe(400);
  });

  it('returns 400 when bodyMd is whitespace-only (post)', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: WRITER.id,
      title: 'Topic for Whitespace Reply',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: NOW,
      rand: 'ws-reply-001',
    });

    const result = await handleCreatePost({
      user: WRITER,
      topicId: topic.id,
      body: { bodyMd: '   ' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });
    expect(result.status).toBe(400);
  });
});

describe('handleCreateTopic: whitespace body', () => {
  it('returns 400 when bodyMd is whitespace-only (topic)', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'general', title: 'Whitespace Body Topic', bodyMd: '   ' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(400);
  });
});

describe('handleCreatePost: rate limiting', () => {
  it('returns 429 on the 21st reply within 600s window', async () => {
    // Use a unique user ID so this test does not share state with others.
    const rateUser = { id: `rate-post-user-${Date.now()}`, roles: ['drep'] };

    // Create a topic to reply to (use WRITER so the topic user is separate).
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: WRITER.id,
      title: 'Rate Limit Reply Topic',
      bodyMd: 'topic body',
      bodyHtml: '<p>topic body</p>',
      now: NOW,
      rand: 'rate-post-topic-001',
    });

    const makeReq = (n: number) =>
      handleCreatePost({
        user: rateUser,
        topicId: topic.id,
        body: { bodyMd: `reply number ${n}` },
        db: db(),
        rateLimiter: rateLimiter(),
        now: NOW + n,
      });

    // 20 allowed.
    for (let i = 1; i <= 20; i++) {
      const r = await makeReq(i);
      expect(r.status, `request ${i} should be 201`).toBe(201);
    }

    // 21st denied.
    const denied = await makeReq(21);
    expect(denied.status).toBe(429);
  });
});

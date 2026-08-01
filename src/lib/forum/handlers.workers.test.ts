/// <reference types="@cloudflare/workers-types" />
// Handler tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Tests handleCreateTopic and handleCreatePost with real D1/KV bindings
// and injected fake user objects. No actual HTTP requests are made.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, getTopicBySlug } from '../db/forum.js';
import { handleCreateTopic, handleCreatePost, handleEditPost } from './handlers.js';
import { getNotificationsPage } from '../db/notifications.js';

// Stable fake user with a real on-chain writer role (drep). 'writer' is not a
// real role; posting is gated by isWriter() which only accepts drep/spo/cc/proposer.
const WRITER = { id: 'user-writer-001', roles: ['drep'] };

// Shared DB and rate-limiter accessors.
const db = () => env.DB;
const rateLimiter = () => env.RATE_LIMITER;

// Fixed timestamp to keep tests deterministic.
const NOW = 1_750_000_000_000;

// Inserts a proposer_grants row directly (bypassing the invite/redeem flow,
// which is exercised elsewhere) so these tests can set up whatever grant
// state the write-path mandate gate needs to see.
async function insertGrant(args: {
  id: string;
  proposerUserId: string;
  coUserId: string;
  status?: 'active' | 'revoked';
}) {
  const status = args.status ?? 'active';
  await db()
    .prepare(
      `INSERT INTO proposer_grants
         (id, proposer_user_id, proposer_stake_addr, co_user_id, co_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at, revoked_at)
       VALUES (?1, ?2, 'stake_test1grantproposer', ?3, 'stake_test1grantco', ?1, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      args.id,
      args.proposerUserId,
      args.coUserId,
      status,
      NOW,
      NOW + 604800,
      status === 'active' ? NOW : null,
      status === 'revoked' ? NOW : null,
    )
    .run();
}

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

  // Authorization-review checkpoint (delegator login, Phase 1): a delegator's
  // session carries only the fallback 'member' role, which must not pass the
  // isWriter gate. Mirrors the "happy path" input above (same category, title,
  // and body), changing only the user's roles to prove the gate, not the input
  // validation, is what rejects them.
  it('rejects a member (delegator) from creating a topic', async () => {
    const result = await handleCreateTopic({
      user: { id: 'stake_test1deleg', roles: ['member'] },
      body: {
        categorySlug: 'general',
        title: 'My Test Topic',
        bodyMd: '**hello world**',
      },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(403);
    expect((result.json as { error: string }).error).toBe('forbidden');
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
// handleCreateTopic / handleCreatePost: co-proposer mandate
// ---------------------------------------------------------------------------

describe('handleCreateTopic: co-proposer mandate', () => {
  it('copies the session grantId onto the topic and its first post', async () => {
    const coUserId = 'grant-co-user-create-topic';
    await insertGrant({ id: 'grant-create-topic-1', proposerUserId: 'proposer-user-1', coUserId });
    const user = { id: coUserId, roles: ['proposer'], grantId: 'grant-create-topic-1' };

    const res = await handleCreateTopic({
      user,
      body: { categorySlug: 'general', title: 'Mandate topic', bodyMd: 'body' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(201);
    const { slug } = res.json as { slug: string };
    const topic = await getTopicBySlug(db(), slug);
    expect(topic?.proposer_grant_id).toBe('grant-create-topic-1');

    const post = await db()
      .prepare('SELECT proposer_grant_id FROM posts WHERE topic_id = ?')
      .bind(topic!.id)
      .first<{ proposer_grant_id: string | null }>();
    expect(post?.proposer_grant_id).toBe('grant-create-topic-1');
  });

  it('rejects a grant session whose grant is active but owned by another user', async () => {
    await insertGrant({ id: 'grant-owned-by-other', proposerUserId: 'proposer-user-1', coUserId: 'real-co-user' });
    const user = { id: 'impersonator', roles: ['proposer'], grantId: 'grant-owned-by-other' };

    const res = await handleCreateTopic({
      user,
      body: { categorySlug: 'general', title: 'Should be blocked', bodyMd: 'body' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(403);
    expect((res.json as { error: string }).error).toBe('mandate revoked');
  });

  it('non-grant sessions are untouched: writes succeed with proposer_grant_id null', async () => {
    const user = { id: 'plain-writer-no-grant', roles: ['drep'] };
    const res = await handleCreateTopic({
      user,
      body: { categorySlug: 'general', title: 'Plain topic', bodyMd: 'body' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(201);
    const { slug } = res.json as { slug: string };
    const topic = await getTopicBySlug(db(), slug);
    expect(topic?.proposer_grant_id).toBeNull();
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

describe('handleCreatePost: co-proposer mandate', () => {
  it('403 mandate revoked when the grant was revoked; no post inserted', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: WRITER.id,
      title: 'Revoked mandate reply target',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: NOW,
      rand: 'revoked-post-001',
    });
    const coUserId = 'grant-co-user-create-post-revoked';
    await insertGrant({
      id: 'grant-create-post-revoked-1',
      proposerUserId: 'proposer-user-1',
      coUserId,
      status: 'revoked',
    });
    const user = { id: coUserId, roles: ['proposer'], grantId: 'grant-create-post-revoked-1' };

    const before = await db()
      .prepare('SELECT post_count FROM topics WHERE id = ?')
      .bind(topic.id)
      .first<{ post_count: number }>();

    const res = await handleCreatePost({
      user,
      topicId: topic.id,
      body: { bodyMd: 'should not land' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });
    expect(res.status).toBe(403);
    expect((res.json as { error: string }).error).toBe('mandate revoked');

    const after = await db()
      .prepare('SELECT post_count FROM topics WHERE id = ?')
      .bind(topic.id)
      .first<{ post_count: number }>();
    expect(after?.post_count).toBe(before?.post_count);
  });
});

// ---------------------------------------------------------------------------
// reply notifications
// ---------------------------------------------------------------------------

describe('reply notifications', () => {
  it('createPost notifies the topic author', async () => {
    const author = { id: 'author-1', roles: ['drep'] };
    const replier = { id: 'replier-1', roles: ['spo'] };

    const topicRes = await handleCreateTopic({
      user: author,
      body: { categorySlug: 'general', title: 'Notify me', bodyMd: 'original post' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(topicRes.status).toBe(201);
    const { slug } = topicRes.json as { slug: string };
    const topicRow = await db().prepare('SELECT id FROM topics WHERE slug = ?').bind(slug).first<{ id: string }>();

    const replyRes = await handleCreatePost({
      user: replier,
      topicId: topicRow!.id,
      body: { bodyMd: 'a reply' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });
    expect(replyRes.status).toBe(201);

    const rows = await getNotificationsPage(db(), 'author-1', 10);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('reply');
    expect(rows[0].actor_id).toBe('replier-1');
    // The replier never self-notifies.
    expect((await getNotificationsPage(db(), 'replier-1', 10)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mentions in handlers
// ---------------------------------------------------------------------------

describe('mentions in handlers', () => {
  // DRep 'drep1abc' named Alice with slug 'alice-drep', linked to forum user 'user-alice'.
  async function seedMentionTarget() {
    await db()
      .prepare(
        `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at, slug, name)
         VALUES ('drep1abc', 'registered', 1, 0, 0, 'alice-drep', 'Alice')`,
      )
      .run();
    await db()
      .prepare(
        `INSERT INTO users (id, drep_id, created_at, last_verified_at)
         VALUES ('user-alice', 'drep1abc', 0, 0)`,
      )
      .run();
  }

  // Creates a topic as `user` and returns its id.
  async function makeTopic(user: { id: string; roles: string[] }, title: string) {
    const res = await handleCreateTopic({
      user,
      body: { categorySlug: 'general', title, bodyMd: 'opening' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(201);
    const { slug } = res.json as { slug: string };
    const row = await db().prepare('SELECT id FROM topics WHERE slug = ?').bind(slug).first<{ id: string }>();
    return row!.id;
  }

  it('createPost linkifies a resolved mention and writes a single mention notification', async () => {
    await seedMentionTarget();
    const topicId = await makeTopic({ id: 'user-alice', roles: ['drep'] }, 'Mention thread');

    const res = await handleCreatePost({
      user: WRITER,
      topicId,
      body: { bodyMd: 'ping @alice-drep' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });
    expect(res.status).toBe(201);
    const { postId } = res.json as { postId: string };

    const post = await db().prepare('SELECT body_html FROM posts WHERE id = ?').bind(postId).first<{ body_html: string }>();
    expect(post!.body_html).toContain('href="/dreps/alice-drep/"');
    // The link text shows the display name, not the suffixed slug.
    expect(post!.body_html).toContain('>@Alice</a>');

    // Exactly one row: the mention wins, no additional reply row for the same post.
    const rows = await getNotificationsPage(db(), 'user-alice', 10);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('mention');
    expect(rows[0].post_id).toBe(postId);
  });

  it('createTopic writes mention notifications for the opening post', async () => {
    await seedMentionTarget();
    const res = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'general', title: 'Hello', bodyMd: '@alice-drep look' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(201);
    const rows = await getNotificationsPage(db(), 'user-alice', 10);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('mention');
    expect(rows[0].post_id).toBeNull();
  });

  it('editPost re-renders mention links but writes no new notifications', async () => {
    await seedMentionTarget();
    const topicId = await makeTopic(WRITER, 'Edit thread');
    const postRes = await handleCreatePost({
      user: WRITER,
      topicId,
      body: { bodyMd: 'no mention yet' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });
    const { postId } = postRes.json as { postId: string };

    const editRes = await handleEditPost({
      user: WRITER,
      postId,
      body: { bodyMd: 'now @alice-drep' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 2,
    });
    expect(editRes.status).toBe(200);

    const post = await db().prepare('SELECT body_html FROM posts WHERE id = ?').bind(postId).first<{ body_html: string }>();
    expect(post!.body_html).toContain('href="/dreps/alice-drep/"');
    expect((await getNotificationsPage(db(), 'user-alice', 10)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DRep write access follows the synced on-chain status (dreps.active)
// ---------------------------------------------------------------------------

describe('drep write access follows the synced drep status', () => {
  // Seeds the users row (as a drep login would create it) plus, optionally,
  // the synced dreps row the write gate reads.
  async function insertDrepUser(args: { userId: string; drepId: string; active?: boolean }) {
    await db()
      .prepare(
        `INSERT INTO users (id, drep_id, is_drep, created_at, last_verified_at)
         VALUES (?1, ?2, 1, ?3, ?3)`,
      )
      .bind(args.userId, args.drepId, NOW)
      .run();
    if (args.active !== undefined) {
      await db()
        .prepare(
          `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?4)`,
        )
        .bind(args.drepId, args.active ? 'registered' : 'deregistered', args.active ? 1 : 0, NOW)
        .run();
    }
  }

  it('a deregistered drep cannot create a topic or reply', async () => {
    await insertDrepUser({ userId: 'drep_test1gonedrep', drepId: 'drep_test1gonedrep', active: false });
    const user = { id: 'drep_test1gonedrep', roles: ['drep'] };

    const topicRes = await handleCreateTopic({
      user,
      body: { categorySlug: 'general', title: 'From a deregistered drep', bodyMd: 'nope' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(topicRes.status).toBe(403);
    // The Composer surfaces this string verbatim, so it must be a readable
    // sentence, not an internal slug.
    expect((topicRes.json as { error: string }).error).toBe(
      'Your DRep registration has ended, so posting is disabled.',
    );

    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: WRITER.id,
      title: 'Open thread for the gate test',
      bodyMd: 'first',
      bodyHtml: '<p>first</p>',
      now: NOW,
      rand: 'gate-test-001',
    });
    const replyRes = await handleCreatePost({
      user,
      topicId: topic.id,
      body: { bodyMd: 'reply from a deregistered drep' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW + 1,
    });
    expect(replyRes.status).toBe(403);
  });

  it('an active drep still posts normally', async () => {
    await insertDrepUser({ userId: 'drep_test1livedrep', drepId: 'drep_test1livedrep', active: true });
    const res = await handleCreateTopic({
      user: { id: 'drep_test1livedrep', roles: ['drep'] },
      body: { categorySlug: 'general', title: 'From an active drep', bodyMd: 'hello' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(201);
  });

  it('a drep without a synced dreps row still posts (fresh registration, sync pending)', async () => {
    await insertDrepUser({ userId: 'drep_test1freshdrep', drepId: 'drep_test1freshdrep' });
    const res = await handleCreateTopic({
      user: { id: 'drep_test1freshdrep', roles: ['drep'] },
      body: { categorySlug: 'general', title: 'From a fresh drep', bodyMd: 'hello' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(201);
  });

  it('a second live writer role keeps write access despite a deregistered drep identity', async () => {
    await insertDrepUser({ userId: 'drep_test1dualrole', drepId: 'drep_test1dualrole', active: false });
    const res = await handleCreateTopic({
      user: { id: 'drep_test1dualrole', roles: ['drep', 'proposer'] },
      body: { categorySlug: 'general', title: 'From a dual-role writer', bodyMd: 'hello' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(201);
  });
});

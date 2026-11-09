/// <reference types="@cloudflare/workers-types" />
// Handler tests -- runs in real workerd via @cloudflare/vitest-plugin.
// Tests handleCreateTopic and handleCreatePost with real D1/KV bindings
// and injected fake user objects. No actual HTTP requests are made.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, getTopicBySlug } from '../db/forum.js';
import {
  handleCreateTopic, handleCreatePost, handleEditPost, handleEditTitle, handleDraftUnlink, handleFlagPost, handleReactToPost,
} from './handlers.js';
import { getNotificationsPage } from '../db/notifications.js';
import { buildInsertGovernanceAction } from '../db/governance.js';
import { buildDraftLinkStatements } from '../db/draftLinks.js';
import { DRAFT_OPENING_BODY_MAX, POST_BODY_MAX } from './postLimits.js';

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
// state the write-path mandate resolution needs to see.
const DEFAULT_ACTION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#0';
async function insertGrant(args: {
  id: string;
  proposerUserId: string;
  coUserId: string;
  status?: 'active' | 'revoked';
  govActionId?: string;
  proposerStakeAddr?: string;
}) {
  const status = args.status ?? 'active';
  await db()
    .prepare(
      `INSERT INTO proposer_grants
         (id, proposer_user_id, proposer_stake_addr, gov_action_id, co_user_id, co_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at, revoked_at)
       VALUES (?1, ?2, ?9, ?10, ?3, ?11, ?1, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      args.id,
      args.proposerUserId,
      args.coUserId,
      status,
      NOW,
      NOW + 604800,
      NOW,
      status === 'revoked' ? NOW : null,
      args.proposerStakeAddr ?? 'stake_test1grantproposer',
      args.govActionId ?? DEFAULT_ACTION_ID,
      `stake_test1co${args.coUserId}`,
    )
    .run();
}

const revokeGrantRow = (id: string) =>
  db().prepare(`UPDATE proposer_grants SET status = 'revoked', revoked_at = ? WHERE id = ?`).bind(NOW, id).run();

let govSeq = 0;
/** A governance thread plus its action row, the target of a per-action grant. */
async function governanceThread() {
  const s = govSeq++;
  const { topic } = await createTopic(db(), {
    categorySlug: 'governance-actions', authorId: 'gov-sync', title: `Mandate gov ${s}`, bodyMd: 'x', bodyHtml: '<p>x</p>',
    source: 'governance', now: NOW, rand: `mg${s}`,
  });
  const actionId = `${'ef'.repeat(31)}${String(s).padStart(2, '0')}#0`;
  await buildInsertGovernanceAction(db(), {
    id: actionId, proposalId: null, type: 'InfoAction', title: 'Mandate action', abstract: null, rationaleHtml: null,
    authors: null, references: null, anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor',
    returnAddress: 'stake_test1grantproposer', deposit: null, submittedEpoch: 1, submittedAt: null, expiryEpoch: null,
    enactedEpoch: null, onchainPayload: null, metaVersion: 1, topicId: topic.id, now: NOW,
  }).run();
  return { topicId: topic.id, actionId };
}

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

  it('returns 403 for the surveys category', async () => {
    const result = await handleCreateTopic({
      user: WRITER,
      body: { categorySlug: 'surveys', title: 'Survey Post', bodyMd: 'body' },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(result.status).toBe(403);
    expect((result.json as { error: string }).error).toBe('cannot post in this category');
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
  it('stamps a draft opened by a pure co-proposer onto the topic and its first post', async () => {
    const coUserId = 'grant-co-user-create-topic';
    await insertGrant({ id: 'grant-create-topic-1', proposerUserId: 'proposer-user-1', coUserId });
    const user = { id: coUserId, roles: ['co-proposer'] };

    const res = await handleCreateTopic({
      user,
      body: { categorySlug: 'proposal-drafts', title: 'Mandate draft', bodyMd: 'body' },
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

  it('refuses a pure co-proposer whose only grant belongs to another user', async () => {
    await insertGrant({ id: 'grant-owned-by-other', proposerUserId: 'proposer-user-1', coUserId: 'real-co-user' });
    const user = { id: 'impersonator', roles: ['co-proposer'] };

    const res = await handleCreateTopic({
      user,
      body: {
        categorySlug: 'proposal-drafts', title: 'Should be blocked', bodyMd: 'body',
        actAs: { proposerStakeAddr: 'stake_test1grantproposer' },
      },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(403);
    const count = await db()
      .prepare(`SELECT COUNT(*) AS n FROM topics WHERE author_id = 'impersonator'`)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
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
  it('403 for a pure co-proposer whose grant was revoked; no post inserted', async () => {
    const { topicId, actionId } = await governanceThread();
    const coUserId = 'grant-co-user-create-post-revoked';
    await insertGrant({
      id: 'grant-create-post-revoked-1',
      proposerUserId: 'proposer-user-1',
      coUserId,
      govActionId: actionId,
    });
    const user = { id: coUserId, roles: ['co-proposer'] };
    const post = (bodyMd: string) =>
      handleCreatePost({ user, topicId, body: { bodyMd }, db: db(), rateLimiter: rateLimiter(), now: NOW + 1 });

    expect((await post('lands while the grant is active')).status).toBe(201);
    await revokeGrantRow('grant-create-post-revoked-1');

    const before = await db()
      .prepare('SELECT post_count FROM topics WHERE id = ?')
      .bind(topicId)
      .first<{ post_count: number }>();
    const res = await post('should not land');
    expect(res.status).toBe(403);
    const after = await db()
      .prepare('SELECT post_count FROM topics WHERE id = ?')
      .bind(topicId)
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

// ---------------------------------------------------------------------------
// handleDraftUnlink
// ---------------------------------------------------------------------------

describe('handleDraftUnlink', () => {
  const AUTHOR = { id: 'draft-owner-1', roles: ['drep'] };
  let seq = 0;

  async function linkedDraft(opts: { grantId?: string | null } = {}) {
    const s = seq++;
    const { topic: draft } = await createTopic(db(), {
      categorySlug: 'proposal-drafts', authorId: AUTHOR.id, title: `Draft ${s}`, bodyMd: 'x', bodyHtml: '<p>x</p>',
      source: 'user', now: NOW, rand: `du${s}`, proposerGrantId: opts.grantId ?? null,
    });
    const { topic: gov } = await createTopic(db(), {
      categorySlug: 'governance-actions', authorId: 'gov-sync', title: `Gov ${s}`, bodyMd: 'x', bodyHtml: '<p>x</p>',
      source: 'governance', now: NOW, rand: `gu${s}`,
    });
    const actionId = `${'ab'.repeat(31)}${String(s).padStart(2, '0')}#0`;
    await buildInsertGovernanceAction(db(), {
      id: actionId, proposalId: null, type: 'InfoAction', title: 'Foreign action', abstract: null, rationaleHtml: null,
      authors: null, references: null, anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor',
      returnAddress: null, deposit: null, submittedEpoch: 1, submittedAt: null, expiryEpoch: null,
      enactedEpoch: null, onchainPayload: null, metaVersion: 1, topicId: gov.id, now: NOW,
    }).run();
    await db().batch(buildDraftLinkStatements(db(), actionId, draft.id));
    return { draft, actionId };
  }

  const call = (user: { id: string; roles: string[] } | null, topicId: string, actionId: unknown) =>
    handleDraftUnlink({ user, topicId, body: { actionId }, db: db(), rateLimiter: rateLimiter(), now: NOW });

  it('lets the author unlink, which reopens the draft', async () => {
    const { draft, actionId } = await linkedDraft();
    const res = await call(AUTHOR, draft.id, actionId);
    expect(res.status).toBe(200);
    const t = await db().prepare('SELECT locked FROM topics WHERE id = ?').bind(draft.id).first<{ locked: number }>();
    expect(t!.locked).toBe(0);
  });

  it('lets a moderator unlink', async () => {
    const { draft, actionId } = await linkedDraft();
    expect((await call({ id: 'mod-1', roles: ['moderator'] }, draft.id, actionId)).status).toBe(200);
  });

  it('lets the author unlink without a writer role', async () => {
    const { draft, actionId } = await linkedDraft();
    expect((await call({ id: AUTHOR.id, roles: ['member'] }, draft.id, actionId)).status).toBe(200);
  });

  it('refuses anyone else', async () => {
    const { draft, actionId } = await linkedDraft();
    expect((await call(null, draft.id, actionId)).status).toBe(401);
    expect((await call({ id: 'other-writer', roles: ['drep'] }, draft.id, actionId)).status).toBe(403);
  });

  it('accepts the author of a draft stamped with an active grant, also without a writer role', async () => {
    await insertGrant({ id: 'grant-unlink-active', proposerUserId: 'principal-1', coUserId: AUTHOR.id, govActionId: `${'a1'.repeat(32)}#0` });
    const { draft, actionId } = await linkedDraft({ grantId: 'grant-unlink-active' });
    expect((await call({ id: AUTHOR.id, roles: ['co-proposer'] }, draft.id, actionId)).status).toBe(200);
  });

  it('refuses a draft stamped with revoked grant A although grant B of the same user is active', async () => {
    await insertGrant({ id: 'grant-unlink-a', proposerUserId: 'principal-1', coUserId: AUTHOR.id, govActionId: `${'a2'.repeat(32)}#0` });
    await insertGrant({ id: 'grant-unlink-b', proposerUserId: 'principal-1', coUserId: AUTHOR.id, govActionId: `${'a3'.repeat(32)}#0` });
    const { draft, actionId } = await linkedDraft({ grantId: 'grant-unlink-a' });
    await revokeGrantRow('grant-unlink-a');
    expect((await call(AUTHOR, draft.id, actionId)).status).toBe(403);
  });

  it('refuses the author on a draft stamped with a grant that does not exist', async () => {
    const { draft, actionId } = await linkedDraft({ grantId: 'grant-x' });
    expect((await call(AUTHOR, draft.id, actionId)).status).toBe(403);
  });

  it('answers 404 for an action that is not linked to this draft, and 400 for a missing id', async () => {
    const { draft } = await linkedDraft();
    expect((await call(AUTHOR, draft.id, `${'ff'.repeat(32)}#0`)).status).toBe(404);
    expect((await call(AUTHOR, draft.id, '')).status).toBe(400);
  });

  it('answers 404 outside Proposal Drafts', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general', authorId: AUTHOR.id, title: 'Plain thread', bodyMd: 'x', bodyHtml: '<p>x</p>',
      source: 'user', now: NOW, rand: 'plain1',
    });
    expect((await call(AUTHOR, topic.id, `${'ab'.repeat(32)}#0`)).status).toBe(404);
  });

  it('refuses to unlink another draft\'s action even for the same author, and leaves that draft untouched', async () => {
    const { topic: draftA } = await createTopic(db(), {
      categorySlug: 'proposal-drafts', authorId: AUTHOR.id, title: 'Draft A', bodyMd: 'x', bodyHtml: '<p>x</p>',
      source: 'user', now: NOW, rand: `du${seq++}`,
    });
    const { draft: draftB, actionId } = await linkedDraft();
    expect((await call(AUTHOR, draftA.id, actionId)).status).toBe(404);
    const action = await db()
      .prepare('SELECT draft_topic_id, draft_link_rejected FROM governance_actions WHERE id = ?')
      .bind(actionId)
      .first<{ draft_topic_id: string; draft_link_rejected: number }>();
    expect(action!.draft_topic_id).toBe(draftB.id);
    expect(action!.draft_link_rejected).toBe(0);
    const topicB = await db().prepare('SELECT locked FROM topics WHERE id = ?').bind(draftB.id).first<{ locked: number }>();
    expect(topicB!.locked).toBe(1);
  });

  it('answers 400 for a null body instead of throwing into the 500 path', async () => {
    const { draft } = await linkedDraft();
    const res = await handleDraftUnlink({
      user: AUTHOR, topicId: draft.id, body: null as unknown as { actionId: unknown },
      db: db(), rateLimiter: rateLimiter(), now: NOW,
    });
    expect(res.status).toBe(400);
  });
});

describe('handleCreateTopic: proposal drafts', () => {
  it('lets a writer open a draft and refuses a member', async () => {
    const ok = await handleCreateTopic({
      user: WRITER, body: { categorySlug: 'proposal-drafts', title: 'A first draft', bodyMd: '## Summary' },
      db: db(), rateLimiter: rateLimiter(), now: NOW,
    });
    expect(ok.status).toBe(201);
    const denied = await handleCreateTopic({
      user: { id: 'member-1', roles: ['member'] }, body: { categorySlug: 'proposal-drafts', title: 'Nope', bodyMd: 'x' },
      db: db(), rateLimiter: rateLimiter(), now: NOW,
    });
    expect(denied.status).toBe(403);
  });
});

describe('Proposal Drafts body caps', () => {
  const DRAFTER = { id: 'drafter-cap-1', roles: ['drep'] };
  const long = (n: number) => 'x'.repeat(n);

  async function openDraft(bodyMd: string) {
    return handleCreateTopic({
      user: DRAFTER,
      body: { categorySlug: 'proposal-drafts', title: `Long draft ${bodyMd.length}`, bodyMd },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
  }

  it('takes an opening post up to the long cap, and refuses one character more', async () => {
    expect((await openDraft(long(DRAFT_OPENING_BODY_MAX))).status).toBe(201);
    const over = await openDraft(long(DRAFT_OPENING_BODY_MAX + 1));
    expect(over.status).toBe(400);
  });

  it('keeps the normal cap for a topic in any other category', async () => {
    const res = await handleCreateTopic({
      user: DRAFTER,
      body: { categorySlug: 'general', title: 'Too long elsewhere', bodyMd: long(POST_BODY_MAX + 1) },
      db: db(),
      rateLimiter: rateLimiter(),
      now: NOW,
    });
    expect(res.status).toBe(400);
  });

  it('lets the author grow the opening post past the normal cap, but not a reply', async () => {
    const created = await openDraft('## Summary\n\nShort start.');
    const { slug } = created.json as { slug: string };
    const topic = await getTopicBySlug(db(), slug);
    const opening = await db()
      .prepare('SELECT id FROM posts WHERE topic_id = ? ORDER BY created_at LIMIT 1')
      .bind(topic!.id)
      .first<{ id: string }>();

    const grown = await handleEditPost({
      user: DRAFTER, postId: opening!.id, body: { bodyMd: long(POST_BODY_MAX + 5000) },
      db: db(), rateLimiter: rateLimiter(), now: NOW + 1,
    });
    expect(grown.status).toBe(200);

    const reply = await handleCreatePost({
      user: DRAFTER, topicId: topic!.id, body: { bodyMd: 'A reply.' },
      db: db(), rateLimiter: rateLimiter(), now: NOW + 2,
    });
    const { postId } = reply.json as { postId: string };
    const replyEdit = await handleEditPost({
      user: DRAFTER, postId, body: { bodyMd: long(POST_BODY_MAX + 1) },
      db: db(), rateLimiter: rateLimiter(), now: NOW + 3,
    });
    expect(replyEdit.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Per-write co-proposer mandates: the thread of the grant's action and
// Proposal Drafts only, re-checked in D1 on every write and edit
// ---------------------------------------------------------------------------

describe('per-write co-proposer mandates', () => {
  const pureCo = (id: string) => ({ id, roles: ['co-proposer'] });
  const postIn = (user: { id: string; roles: string[] }, topicId: string, body: Record<string, unknown> = {}) =>
    handleCreatePost({ user, topicId, body: { bodyMd: 'a reply', ...body }, db: db(), rateLimiter: rateLimiter(), now: NOW + 1 });
  const topicIn = (user: { id: string; roles: string[] }, body: Record<string, unknown>) =>
    handleCreateTopic({ user, body: { title: 'A mandate draft', bodyMd: 'body', ...body } as never, db: db(), rateLimiter: rateLimiter(), now: NOW });
  const grantOf = async (table: 'posts' | 'topics', id: string) =>
    (await db().prepare(`SELECT proposer_grant_id FROM ${table} WHERE id = ?`).bind(id).first<{ proposer_grant_id: string | null }>())
      ?.proposer_grant_id;

  it('a pure co-proposer posts in the thread of its action, stamped with that grant', async () => {
    const a = await governanceThread();
    await insertGrant({ id: 'm-pure-a', proposerUserId: 'p1', coUserId: 'm-pure', govActionId: a.actionId });
    const res = await postIn(pureCo('m-pure'), a.topicId);
    expect(res.status).toBe(201);
    expect(await grantOf('posts', (res.json as { postId: string }).postId)).toBe('m-pure-a');
  });

  it('the same co-proposer gets 403 in the thread of another action of the same return address', async () => {
    const a = await governanceThread();
    const b = await governanceThread();
    await insertGrant({ id: 'm-pure-b-a', proposerUserId: 'p1', coUserId: 'm-pure-b', govActionId: a.actionId });
    expect((await postIn(pureCo('m-pure-b'), b.topicId)).status).toBe(403);
  });

  it('a pure co-proposer cannot open a topic in a general category, but can in Proposal Drafts', async () => {
    await insertGrant({ id: 'm-pure-t', proposerUserId: 'p1', coUserId: 'm-pure-t-user' });
    expect((await topicIn(pureCo('m-pure-t-user'), { categorySlug: 'general' })).status).toBe(403);
    const ok = await topicIn(pureCo('m-pure-t-user'), { categorySlug: 'proposal-drafts' });
    expect(ok.status).toBe(201);
    const topic = await getTopicBySlug(db(), (ok.json as { slug: string }).slug);
    expect(topic?.proposer_grant_id).toBe('m-pure-t');
  });

  it('a pure co-proposer replies in any Proposal Drafts thread under the mandate', async () => {
    await insertGrant({ id: 'm-draft-reply', proposerUserId: 'p1', coUserId: 'm-draft-replier' });
    const { topic } = await createTopic(db(), {
      categorySlug: 'proposal-drafts', authorId: WRITER.id, title: 'Someone else draft', bodyMd: 'x', bodyHtml: '<p>x</p>',
      source: 'user', now: NOW, rand: 'mdr1',
    });
    const res = await postIn(pureCo('m-draft-replier'), topic.id);
    expect(res.status).toBe(201);
    expect(await grantOf('posts', (res.json as { postId: string }).postId)).toBe('m-draft-reply');
  });

  it('a DRep with a grant for A posts in B as themselves, unstamped', async () => {
    const a = await governanceThread();
    const b = await governanceThread();
    await insertGrant({ id: 'm-drep-a', proposerUserId: 'p1', coUserId: 'm-drep', govActionId: a.actionId });
    const res = await postIn({ id: 'm-drep', roles: ['drep', 'co-proposer'] }, b.topicId);
    expect(res.status).toBe(201);
    expect(await grantOf('posts', (res.json as { postId: string }).postId)).toBeNull();
  });

  it('a DRep whose registration ended still writes under an active grant in its thread', async () => {
    const a = await governanceThread();
    await insertDrepUser({ userId: 'drep_test1mandategone', drepId: 'drep_test1mandategone', active: false });
    await insertGrant({ id: 'm-gone-a', proposerUserId: 'p1', coUserId: 'drep_test1mandategone', govActionId: a.actionId });
    const user = { id: 'drep_test1mandategone', roles: ['drep', 'co-proposer'] };
    const res = await postIn(user, a.topicId);
    expect(res.status).toBe(201);
    expect(await grantOf('posts', (res.json as { postId: string }).postId)).toBe('m-gone-a');
    // Outside the thread the ended registration still blocks the write.
    const b = await governanceThread();
    expect((await postIn(user, b.topicId)).status).toBe(403);
  });

  it('a DRep edit of their own post stamped with a since revoked grant is refused', async () => {
    const a = await governanceThread();
    await insertGrant({ id: 'm-edit-drep', proposerUserId: 'p1', coUserId: 'm-edit-drep-user', govActionId: a.actionId });
    const user = { id: 'm-edit-drep-user', roles: ['drep', 'co-proposer'] };
    const created = await postIn(user, a.topicId);
    const postId = (created.json as { postId: string }).postId;
    await revokeGrantRow('m-edit-drep');
    const res = await handleEditPost({ user, postId, body: { bodyMd: 'edited' }, db: db(), rateLimiter: rateLimiter(), now: NOW + 2 });
    expect(res.status).toBe(403);
    const row = await db().prepare('SELECT body_md FROM posts WHERE id = ?').bind(postId).first<{ body_md: string }>();
    expect(row?.body_md).toBe('a reply');
  });

  it('a pure co-proposer cannot flag or react, even with an active grant', async () => {
    await insertGrant({ id: 'm-judge', proposerUserId: 'p1', coUserId: 'm-judge-user' });
    const { firstPost } = await createTopic(db(), {
      categorySlug: 'general', authorId: WRITER.id, title: 'Judge target', bodyMd: 'x', bodyHtml: '<p>x</p>',
      source: 'user', now: NOW, rand: 'mj1',
    });
    const input = { user: pureCo('m-judge-user'), postId: firstPost.id, db: db(), rateLimiter: rateLimiter(), now: NOW };
    expect((await handleFlagPost(input)).status).toBe(403);
    expect((await handleReactToPost(input, 'up')).status).toBe(403);
  });

  it('a deregistered DRep with an old session cannot flag or react', async () => {
    await insertDrepUser({ userId: 'drep_test1judgegone', drepId: 'drep_test1judgegone', active: false });
    const { firstPost } = await createTopic(db(), {
      categorySlug: 'general', authorId: WRITER.id, title: 'Judge target 2', bodyMd: 'x', bodyHtml: '<p>x</p>',
      source: 'user', now: NOW, rand: 'mj2',
    });
    const input = {
      user: { id: 'drep_test1judgegone', roles: ['drep'] }, postId: firstPost.id, db: db(), rateLimiter: rateLimiter(), now: NOW,
    };
    expect((await handleFlagPost(input)).status).toBe(403);
    expect((await handleReactToPost(input, 'up')).status).toBe(403);
  });

  it('a pure co-proposer edits their stamped post and draft title while the grant is active, 403 after revoke', async () => {
    const a = await governanceThread();
    await insertGrant({ id: 'm-edit-a', proposerUserId: 'p1', coUserId: 'm-edit-co', govActionId: a.actionId });
    const user = pureCo('m-edit-co');
    const postId = ((await postIn(user, a.topicId)).json as { postId: string }).postId;
    const draft = await topicIn(user, { categorySlug: 'proposal-drafts' });
    expect(draft.status).toBe(201);
    const draftTopic = await getTopicBySlug(db(), (draft.json as { slug: string }).slug);
    expect(draftTopic?.proposer_grant_id).toBe('m-edit-a');

    const editPostReq = (bodyMd: string) =>
      handleEditPost({ user, postId, body: { bodyMd }, db: db(), rateLimiter: rateLimiter(), now: NOW + 2 });
    const editTitleReq = (title: string) =>
      handleEditTitle({ user, topicId: draftTopic!.id, body: { title }, db: db(), rateLimiter: rateLimiter(), now: NOW + 2 });

    expect((await editPostReq('edited under the mandate')).status).toBe(200);
    expect((await editTitleReq('A sharper draft title')).status).toBe(200);

    await revokeGrantRow('m-edit-a');
    expect((await editPostReq('after revoke')).status).toBe(403);
    expect((await editTitleReq('Title after revoke')).status).toBe(403);
  });

  it('a pure co-proposer cannot edit an unstamped post of their own', async () => {
    const { firstPost } = await createTopic(db(), {
      categorySlug: 'general', authorId: 'm-unstamped-co', title: 'Old personal post', bodyMd: 'x', bodyHtml: '<p>x</p>',
      source: 'user', now: NOW, rand: 'mus1',
    });
    await insertGrant({ id: 'm-unstamped', proposerUserId: 'p1', coUserId: 'm-unstamped-co' });
    const res = await handleEditPost({
      user: pureCo('m-unstamped-co'), postId: firstPost.id, body: { bodyMd: 'nope' }, db: db(), rateLimiter: rateLimiter(), now: NOW + 2,
    });
    expect(res.status).toBe(403);
  });

  it('a Proposal Drafts choice of a proposer the user holds no grant from stamps nothing', async () => {
    await insertGrant({ id: 'm-forged-own', proposerUserId: 'p1', coUserId: 'm-forged-writer' });
    await insertGrant({ id: 'm-forged-own-co', proposerUserId: 'p1', coUserId: 'm-forged-co' });
    const forged = { actAs: { proposerStakeAddr: 'stake_test1someoneelse' }, categorySlug: 'proposal-drafts' };

    const writer = await topicIn({ id: 'm-forged-writer', roles: ['drep', 'co-proposer'] }, forged);
    expect(writer.status).toBe(201);
    const topic = await getTopicBySlug(db(), (writer.json as { slug: string }).slug);
    expect(topic?.proposer_grant_id).toBeNull();

    expect((await topicIn(pureCo('m-forged-co'), forged)).status).toBe(403);
  });

  it('a writer chooses to open a draft as themselves', async () => {
    await insertGrant({ id: 'm-self', proposerUserId: 'p1', coUserId: 'm-self-writer' });
    const res = await topicIn({ id: 'm-self-writer', roles: ['drep', 'co-proposer'] }, { categorySlug: 'proposal-drafts', actAs: 'self' });
    expect(res.status).toBe(201);
    const topic = await getTopicBySlug(db(), (res.json as { slug: string }).slug);
    expect(topic?.proposer_grant_id).toBeNull();
  });

  it('grants from two proposers and no choice: 400 choose_proposer', async () => {
    await insertGrant({ id: 'm-two-a', proposerUserId: 'p1', coUserId: 'm-two', govActionId: `${'b1'.repeat(32)}#0` });
    await insertGrant({
      id: 'm-two-b', proposerUserId: 'p2', coUserId: 'm-two', govActionId: `${'b2'.repeat(32)}#0`,
      proposerStakeAddr: 'stake_test1secondproposer',
    });
    const res = await topicIn(pureCo('m-two'), { categorySlug: 'proposal-drafts' });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toBe('choose_proposer');

    const chosen = await topicIn(pureCo('m-two'), {
      categorySlug: 'proposal-drafts', actAs: { proposerStakeAddr: 'stake_test1secondproposer' },
    });
    expect(chosen.status).toBe(201);
    const topic = await getTopicBySlug(db(), (chosen.json as { slug: string }).slug);
    expect(topic?.proposer_grant_id).toBe('m-two-b');
  });
});

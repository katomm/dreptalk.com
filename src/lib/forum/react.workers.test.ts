/// <reference types="@cloudflare/workers-types" />
// Reaction handler tests -- run in real workerd via @cloudflare/vitest-pool-workers.
// Tests handleReactToPost / handleClearReaction authorization and state
// transitions against real D1/KV bindings with injected fake user objects.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, getPostById } from '../db/forum.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { handleReactToPost, handleClearReaction } from './handlers.js';

const db = () => env.DB;
const rateLimiter = () => env.RATE_LIMITER;
const NOW = 1_752_000_000_000;

const WRITER = { id: 'drep-reactor-1', roles: ['drep'] };

let seq = 0;
// Creates a topic authored by `authorId` and returns its first post id.
async function newPost(authorId: string, source: 'user' | 'governance' = 'user'): Promise<string> {
  seq++;
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general',
    authorId,
    title: `React handler fixture ${seq}`,
    bodyMd: 'body',
    bodyHtml: '<p>body</p>',
    source,
    now: NOW,
    rand: `rh${seq}`,
  });
  return firstPost.id;
}

function reactInput(user: { id: string; roles: string[]; grantId?: string | null } | null, postId: string) {
  return { user, postId, db: db(), rateLimiter: rateLimiter(), now: NOW };
}

// Inserts a proposer_grants row directly (bypassing the invite/redeem flow,
// which is exercised elsewhere) so this test can set up a revoked grant.
async function insertGrant(args: { id: string; proposerUserId: string; coUserId: string; status: 'active' | 'revoked' }) {
  await db()
    .prepare(
      `INSERT INTO proposer_grants
         (id, proposer_user_id, proposer_stake_addr, co_user_id, co_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at, revoked_at)
       VALUES (?1, ?2, 'stake_test1reactproposer', ?3, 'stake_test1reactco', ?1, ?4, ?5, ?6, ?7, ?8)`,
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

describe('handleReactToPost: authorization and validation', () => {
  it('401 when unauthenticated', async () => {
    const postId = await newPost('someone-else');
    const r = await handleReactToPost(reactInput(null, postId), 'up');
    expect(r.status).toBe(401);
  });

  it('403 for a non-writer role', async () => {
    const postId = await newPost('someone-else');
    const r = await handleReactToPost(reactInput({ id: 'member-1', roles: ['member'] }, postId), 'up');
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('forbidden');
  });

  it('400 for an invalid reaction value', async () => {
    const postId = await newPost('someone-else');
    const r = await handleReactToPost(reactInput(WRITER, postId), 'sideways');
    expect(r.status).toBe(400);
  });

  it('404 when the post does not exist', async () => {
    const r = await handleReactToPost(reactInput(WRITER, crypto.randomUUID()), 'up');
    expect(r.status).toBe(404);
  });

  it('403 when reacting to your own post', async () => {
    const postId = await newPost(WRITER.id);
    const r = await handleReactToPost(reactInput(WRITER, postId), 'up');
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('cannot_react_own');
  });

  it('403 when reacting to a system post', async () => {
    const postId = await newPost(GOV_SYNC_AUTHOR, 'governance');
    const r = await handleReactToPost(reactInput(WRITER, postId), 'up');
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('cannot_react_system');
  });

  it('403 when withdrawing a reaction on a system post', async () => {
    const postId = await newPost(GOV_SYNC_AUTHOR, 'governance');
    const r = await handleClearReaction(reactInput(WRITER, postId));
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('cannot_react_system');
  });

  it('403 mandate revoked when the reactor\'s grant was revoked', async () => {
    const postId = await newPost('someone-else');
    const coUserId = 'grant-co-user-react';
    await insertGrant({ id: 'grant-react-1', proposerUserId: 'proposer-user-1', coUserId, status: 'revoked' });
    const r = await handleReactToPost(
      reactInput({ id: coUserId, roles: ['proposer'], grantId: 'grant-react-1' }, postId),
      'up',
    );
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('mandate revoked');
  });

});

describe('handleReactToPost: state', () => {
  it('counts the reaction and materializes it on the post', async () => {
    const postId = await newPost('someone-else');

    const r = await handleReactToPost(reactInput(WRITER, postId), 'up');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, reaction: 'up', upCount: 1, downCount: 0 });

    const post = await getPostById(db(), postId);
    expect(post!.up_count).toBe(1);
    expect(post!.down_count).toBe(0);
  });

  it('switching sides replaces the previous reaction', async () => {
    const postId = await newPost('someone-else');

    await handleReactToPost(reactInput(WRITER, postId), 'up');
    const r = await handleReactToPost(reactInput(WRITER, postId), 'down');
    expect(r.json).toMatchObject({ reaction: 'down', upCount: 0, downCount: 1 });
  });

  it('repeating the same reaction is idempotent', async () => {
    const postId = await newPost('someone-else');

    await handleReactToPost(reactInput(WRITER, postId), 'up');
    const r = await handleReactToPost(reactInput(WRITER, postId), 'up');
    expect(r.json).toMatchObject({ reaction: 'up', upCount: 1, downCount: 0 });
  });

  it('counts distinct reactors separately', async () => {
    const postId = await newPost('someone-else');

    await handleReactToPost(reactInput({ id: 'drep-a', roles: ['drep'] }, postId), 'up');
    await handleReactToPost(reactInput({ id: 'spo-b', roles: ['spo'] }, postId), 'up');
    const r = await handleReactToPost(reactInput({ id: 'cc-c', roles: ['cc'] }, postId), 'down');
    expect(r.json).toMatchObject({ upCount: 2, downCount: 1 });
  });
});

describe('handleClearReaction', () => {
  it('withdraws the reaction and reports the lowered counts', async () => {
    const postId = await newPost('someone-else');
    await handleReactToPost(reactInput(WRITER, postId), 'up');

    const r = await handleClearReaction(reactInput(WRITER, postId));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, reaction: null, upCount: 0, downCount: 0 });
  });

  it('is a no-op when no reaction exists', async () => {
    const postId = await newPost('someone-else');
    const r = await handleClearReaction(reactInput(WRITER, postId));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, upCount: 0, downCount: 0 });
  });
});

describe('handleReactToPost: rate limiting', () => {
  it('429 after the per-user limit is exceeded', async () => {
    const rater = { id: 'drep-react-rater', roles: ['drep'] };
    // 60 toggles per 600s are allowed; the 61st is limited.
    let limited = false;
    for (let i = 0; i < 61; i++) {
      const postId = await newPost('someone-else');
      const r = await handleReactToPost(reactInput(rater, postId), 'up');
      if (r.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

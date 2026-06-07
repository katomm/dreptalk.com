/// <reference types="@cloudflare/workers-types" />
// Flag handler tests -- run in real workerd via @cloudflare/vitest-pool-workers.
// Tests handleFlagPost / handleUnflagPost authorization and state transitions
// against real D1/KV bindings with injected fake user objects.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, getPostById } from '../db/forum.js';
import { FLAG_HIDE_THRESHOLD } from '../db/postFlags.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { handleFlagPost, handleUnflagPost } from './handlers.js';

const db = () => env.DB;
const rateKv = () => env.NONCES;
const NOW = 1_752_000_000_000;

const WRITER = { id: 'drep-writer-1', roles: ['drep'] };

let seq = 0;
// Creates a topic authored by `authorId` and returns its first post id.
async function newPost(authorId: string, source: 'user' | 'governance' = 'user'): Promise<string> {
  seq++;
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general',
    authorId,
    title: `Flag handler fixture ${seq}`,
    bodyMd: 'body',
    bodyHtml: '<p>body</p>',
    source,
    now: NOW,
    rand: `fh${seq}`,
  });
  return firstPost.id;
}

function flagInput(user: { id: string; roles: string[] } | null, postId: string) {
  return { user, postId, db: db(), rateKv: rateKv(), now: NOW };
}

describe('handleFlagPost: authorization', () => {
  it('401 when unauthenticated', async () => {
    const postId = await newPost('someone-else');
    const r = await handleFlagPost(flagInput(null, postId));
    expect(r.status).toBe(401);
  });

  it('403 for a non-writer role', async () => {
    const postId = await newPost('someone-else');
    const r = await handleFlagPost(flagInput({ id: 'member-1', roles: ['member'] }, postId));
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('forbidden');
  });

  it('404 when the post does not exist', async () => {
    const r = await handleFlagPost(flagInput(WRITER, crypto.randomUUID()));
    expect(r.status).toBe(404);
  });

  it('403 when flagging your own post', async () => {
    const postId = await newPost(WRITER.id);
    const r = await handleFlagPost(flagInput(WRITER, postId));
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('cannot_flag_own');
  });

  it('403 when flagging a system/governance post', async () => {
    const postId = await newPost(GOV_SYNC_AUTHOR, 'governance');
    const r = await handleFlagPost(flagInput(WRITER, postId));
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toBe('cannot_flag_system');
  });
});

describe('handleFlagPost: state', () => {
  it('200 and counts the flag; repeat by same writer is idempotent', async () => {
    const postId = await newPost('someone-else');

    const r1 = await handleFlagPost(flagInput(WRITER, postId));
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ ok: true, flagged: true, flagCount: 1, hidden: false });

    const r2 = await handleFlagPost(flagInput(WRITER, postId));
    expect((r2.json as { flagCount: number }).flagCount).toBe(1);
  });

  it('hides the post once the threshold of distinct writers flag it', async () => {
    const postId = await newPost('someone-else');
    let last: unknown;
    for (let i = 0; i < FLAG_HIDE_THRESHOLD; i++) {
      const r = await handleFlagPost(flagInput({ id: `drep-${i}`, roles: ['drep'] }, postId));
      last = r.json;
    }
    expect(last).toMatchObject({ hidden: true, flagCount: FLAG_HIDE_THRESHOLD });
    expect((await getPostById(db(), postId))!.hidden).toBe(true);
  });
});

describe('handleUnflagPost', () => {
  it('withdraws a flag and reports the lowered count', async () => {
    const postId = await newPost('someone-else');
    await handleFlagPost(flagInput(WRITER, postId));

    const r = await handleUnflagPost(flagInput(WRITER, postId));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, flagged: false, flagCount: 0, hidden: false });
  });
});

describe('handleFlagPost: rate limiting', () => {
  it('429 after the per-user limit is exceeded', async () => {
    const rater = { id: 'drep-rater', roles: ['drep'] };
    // 30 toggles per 600s are allowed; the 31st is limited.
    let limited = false;
    for (let i = 0; i < 31; i++) {
      const postId = await newPost('someone-else');
      const r = await handleFlagPost(flagInput(rater, postId));
      if (r.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

// src/lib/forum/editEmit.workers.test.ts
// The edit handler emits, and never fails the edit when emitting fails.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from '../db/forum.js';
import { getHeadDoc, listPostVersions, getDocBody } from '../db/cip100.js';
import { reconcilePostDocs } from '../cip100/reconcile.js';
import { EDIT_GRACE_MS } from './editPolicy.js';
import { handleEditPost } from './handlers.js';

const db = () => env.DB;
const T = 1_700_000_000_000;
const AFTER_GRACE = T + EDIT_GRACE_MS + 1000;
const USER = { id: 'test-author-emit', roles: ['drep'], grantId: null };

describe('handleEditPost CIP-100 emit', () => {
  it('emits a new version after an edit', async () => {
    const { firstPost } = await createTopic(db(), {
      categorySlug: 'general', authorId: 'test-author-emit', title: 'Emit on edit',
      bodyMd: 'first body', bodyHtml: '<p>first body</p>', now: T, rand: 'e1',
    });
    await reconcilePostDocs(db(), firstPost.id, {
      origin: 'https://dreptalk.com', network: 'mainnet', now: AFTER_GRACE,
    });
    const res = await handleEditPost({
      user: USER, postId: firstPost.id, body: { bodyMd: 'a clearly different body' },
      db: db(), rateLimiter: env.RATE_LIMITER, now: AFTER_GRACE + 2000,
    });
    expect(res.status).toBe(200);
    expect((await getHeadDoc(db(), firstPost.id))?.version).toBe(2);
  });

  it('preserves the pre-edit text when the first edit beats the cron', async () => {
    // The window this guards: grace has closed, the cron has not run yet, so no
    // document exists. editPost overwrites body_md in place, so without a
    // reconcile BEFORE the write the publicly visible original would never become
    // a version and the chain would start at the edited text.
    const { firstPost } = await createTopic(db(), {
      categorySlug: 'general', authorId: 'test-author-emit', title: 'Edit beats cron',
      bodyMd: 'the original body', bodyHtml: '<p>the original body</p>', now: T, rand: 'e2',
    });
    const res = await handleEditPost({
      user: USER, postId: firstPost.id, body: { bodyMd: 'the replacement body' },
      db: db(), rateLimiter: env.RATE_LIMITER, now: AFTER_GRACE + 2000,
    });
    expect(res.status).toBe(200);

    const versions = await listPostVersions(db(), firstPost.id);
    expect(versions).toHaveLength(2);
    const v1 = JSON.parse((await getDocBody(db(), versions[0].hash)) as string);
    const v2 = JSON.parse((await getDocBody(db(), versions[1].hash)) as string);
    expect(v1.body.comment).toBe('the original body');
    expect('revisedAt' in v1.body).toBe(false);
    expect(v2.body.comment).toBe('the replacement body');
    expect(v2.body.revisionOf).toContain(versions[0].hash);
  });
});

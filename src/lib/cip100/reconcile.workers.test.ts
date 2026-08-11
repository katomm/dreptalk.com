// src/lib/cip100/reconcile.workers.test.ts
// The reconciler is the only writer to cip100_docs. These tests pin the four
// rules that are easy to get wrong: the grace window, no-op edits, the chain,
// and repair after a failed emit.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost, editPost } from '../db/forum.js';
import { getHeadDoc, listPostVersions, findStalePostIds, insertDoc, getDocBody } from '../db/cip100.js';
import { reconcilePostDocs } from './reconcile.js';
import { EDIT_GRACE_MS } from '../forum/editPolicy.js';

const db = () => env.DB;
const T = 1_700_000_000_000;
const AFTER_GRACE = T + EDIT_GRACE_MS + 1000;
const AUTHOR = 'test-author-reconcile';
const OPTS = { origin: 'https://dreptalk.com', network: 'mainnet' as const };

async function seedTopic(suffix: string, source: 'user' | 'governance' = 'user') {
  return createTopic(db(), {
    categorySlug: 'general', authorId: AUTHOR, title: `Reconcile ${suffix}`,
    bodyMd: 'opening body', bodyHtml: '<p>opening body</p>', source, now: T, rand: suffix,
  });
}

describe('reconcilePostDocs', () => {
  it('emits nothing while the post is inside its grace window', async () => {
    const { firstPost } = await seedTopic('r1');
    const res = await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: T + 1000 });
    expect(res.status).toBe('skipped');
    expect(await getHeadDoc(db(), firstPost.id)).toBeNull();
  });

  it('emits version 1 once the grace window has closed', async () => {
    const { firstPost } = await seedTopic('r2');
    const res = await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    expect(res.status).toBe('created');
    expect((await getHeadDoc(db(), firstPost.id))?.version).toBe(1);
  });

  it('is idempotent', async () => {
    const { firstPost } = await seedTopic('r3');
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    const second = await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE + 1000 });
    expect(second.status).toBe('unchanged');
    expect(await listPostVersions(db(), firstPost.id)).toHaveLength(1);
  });

  it('chains a real edit as version 2', async () => {
    const { topic, firstPost } = await seedTopic('r4');
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    const v1 = await getHeadDoc(db(), firstPost.id);
    await editPost(db(), {
      postId: firstPost.id, authorId: AUTHOR, bodyMd: 'a genuinely different body',
      bodyHtml: '<p>a genuinely different body</p>', now: AFTER_GRACE + 2000, sessionGrantId: null,
    });
    const res = await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE + 3000 });
    expect(res.status).toBe('created');
    const head = await getHeadDoc(db(), firstPost.id);
    expect(head?.version).toBe(2);
    expect(head?.prevHash).toBe(v1?.hash);
    expect(topic.id).toBe(head?.topicId);
  });

  it('creates no version when an edit submits identical markdown', async () => {
    const { firstPost } = await seedTopic('r5');
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    await editPost(db(), {
      postId: firstPost.id, authorId: AUTHOR, bodyMd: 'opening body',
      bodyHtml: '<p>opening body</p>', now: AFTER_GRACE + 2000, sessionGrantId: null,
    });
    const res = await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE + 3000 });
    expect(res.status).toBe('unchanged');
    expect(await listPostVersions(db(), firstPost.id)).toHaveLength(1);
    // And the post must not stay stale forever, or the cron would rebuild it
    // on every single run.
    expect(await findStalePostIds(db(), AFTER_GRACE + 3000, 50)).not.toContain(firstPost.id);
  });

  it('repairs a post whose later version failed to emit', async () => {
    const { firstPost } = await seedTopic('r6');
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    await editPost(db(), {
      postId: firstPost.id, authorId: AUTHOR, bodyMd: 'edited but never emitted',
      bodyHtml: '<p>edited but never emitted</p>', now: AFTER_GRACE + 2000, sessionGrantId: null,
    });
    // Simulates the swallowed failure in the request path: nothing ran.
    expect(await findStalePostIds(db(), AFTER_GRACE + 3000, 50)).toContain(firstPost.id);
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE + 3000 });
    expect((await getHeadDoc(db(), firstPost.id))?.version).toBe(2);
  });

  it('skips the opening post of a governance topic', async () => {
    const { firstPost } = await seedTopic('r7', 'governance');
    const res = await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    expect(res.status).toBe('skipped');
  });

  it('emits a reply inside a governance topic', async () => {
    const { topic, firstPost } = await seedTopic('r8', 'governance');
    const reply = await createPost(db(), {
      topicId: topic.id, authorId: AUTHOR, bodyMd: 'a human reply',
      bodyHtml: '<p>a human reply</p>', now: T + 1000, parentPostId: firstPost.id,
    });
    // The reply's own grace window closes at (T + 1000) + EDIT_GRACE_MS, which
    // equals AFTER_GRACE exactly, so reconciling at AFTER_GRACE would still be
    // inside the reply's grace window. Reconcile clearly after it instead.
    const res = await reconcilePostDocs(db(), reply.id, { ...OPTS, now: AFTER_GRACE + 1000 });
    expect(res.status).toBe('created');
  });

  it('skips a deleted post', async () => {
    const { firstPost } = await seedTopic('r9');
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, firstPost.id).run();
    expect((await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE })).status).toBe('skipped');
  });

  it('rebuilds against the new head after a lost version race', async () => {
    const { firstPost } = await seedTopic('r10');
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    const v1 = await getHeadDoc(db(), firstPost.id);
    await editPost(db(), {
      postId: firstPost.id, authorId: AUTHOR, bodyMd: 'a racing edit',
      bodyHtml: '<p>a racing edit</p>', now: AFTER_GRACE + 2000, sessionGrantId: null,
    });
    // Simulate a writer that already took version 2 before this reconcile runs.
    // That occupies the (post_id, version) slot the reconciler would otherwise
    // build for.
    const racingHash = 'b'.repeat(64);
    const racing = await insertDoc(db(), {
      hash: racingHash, body: '{"racing":true}', postId: firstPost.id, topicId: firstPost.topic_id,
      version: 2, prevHash: v1?.hash ?? null, sourceEditedAt: AFTER_GRACE + 2000, createdAt: AFTER_GRACE + 2500,
    });
    expect(racing).toBe('inserted');

    const res = await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE + 3000 });
    // A lost race must still converge to a linear chain, not fail and not fork:
    // the reconciler rebuilds against whatever the current head is.
    expect(res.status).toBe('created');
    const head = await getHeadDoc(db(), firstPost.id);
    expect(head?.version).toBe(3);
    expect(head?.prevHash).toBe(racingHash);
  });

  it('omits inReplyTo when the parent snapshot postdates the reply', async () => {
    const { topic, firstPost } = await seedTopic('r11');
    const reply = await createPost(db(), {
      topicId: topic.id, authorId: AUTHOR, bodyMd: 'a backfilled reply',
      bodyHtml: '<p>a backfilled reply</p>', now: T + 1000, parentPostId: firstPost.id,
    });
    // Reconcile only the parent, producing its one and only snapshot after the
    // reply was already written. That is the backfill situation the guard
    // exists for: the parent's head does not predate the reply.
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    const parentHead = await getHeadDoc(db(), firstPost.id);
    expect(parentHead?.createdAt).toBeGreaterThan(reply.created_at);

    const res = await reconcilePostDocs(db(), reply.id, { ...OPTS, now: AFTER_GRACE + 1000 });
    expect(res.status).toBe('created');
    const body = await getDocBody(db(), res.hash as string);
    const doc = JSON.parse(body as string) as { body: { inReplyToPostId?: string; inReplyTo?: string } };
    expect(doc.body.inReplyToPostId).toBe(firstPost.id);
    expect('inReplyTo' in doc.body).toBe(false);
  });
});

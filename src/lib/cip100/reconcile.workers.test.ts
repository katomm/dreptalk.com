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
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';

const db = () => env.DB;
const T = 1_700_000_000_000;
const AFTER_GRACE = T + EDIT_GRACE_MS + 1000;
const AUTHOR = 'test-author-reconcile';
const OPTS = { origin: 'https://dreptalk.com', network: 'mainnet' as const };

// A synced topic is written by the sync, never by a person, and its mirror post
// carries the same author id. Seeding it any other way would be a shape
// production never produces, and the scope rule keys on exactly that authorship.
async function seedTopic(suffix: string, source: 'user' | 'governance' | 'survey' = 'user') {
  return createTopic(db(), {
    categorySlug: 'general', authorId: source === 'user' ? AUTHOR : GOV_SYNC_AUTHOR,
    title: `Reconcile ${suffix}`,
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

  it('skips the sync-written mirror post of a governance topic', async () => {
    const { firstPost } = await seedTopic('r7', 'governance');
    const res = await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    expect(res.status).toBe('skipped');
  });

  // Reproduces preprod topic c413598c. A vote-rationale cross-post is back-dated
  // to its on-chain vote time, so it can be OLDER than the sync's own mirror
  // post. While the mirror post was identified as the oldest top-level post,
  // the rationale was picked instead and the mirror post was published as if a
  // person had written it. Authorship does not depend on timestamps.
  it('skips the mirror post even when a back-dated rationale post is older', async () => {
    const MIRROR_AT = T + 500_000;
    const { topic, firstPost: mirror } = await createTopic(db(), {
      categorySlug: 'general', authorId: GOV_SYNC_AUTHOR, title: 'Reconcile r14',
      bodyMd: '**On-chain governance action** (No Confidence)', bodyHtml: '<p>on-chain</p>',
      source: 'governance', now: MIRROR_AT, rand: 'r14',
    });
    const rationale = await createPost(db(), {
      topicId: topic.id, authorId: AUTHOR, bodyMd: 'my rationale',
      bodyHtml: '<p>my rationale</p>', now: T,
    });
    await db().prepare("UPDATE posts SET source = 'vote_rationale' WHERE id = ?").bind(rationale.id).run();
    // Guard on the fixture: the shape only reproduces the bug while the
    // rationale really is the older top-level post.
    expect(rationale.parent_post_id).toBeNull();
    expect(rationale.created_at).toBeLessThan(mirror.created_at);

    const at = MIRROR_AT + EDIT_GRACE_MS + 1000;
    expect((await reconcilePostDocs(db(), mirror.id, { ...OPTS, now: at })).status).toBe('skipped');
    // Not merely skipped: it must not occupy a slot in the bounded batch either.
    expect(await findStalePostIds(db(), at - EDIT_GRACE_MS, 50)).not.toContain(mirror.id);

    // The line this rule must not cross: a person's reply in the same governance
    // topic is still emitted.
    const replyAt = MIRROR_AT + 1000;
    const reply = await createPost(db(), {
      topicId: topic.id, authorId: AUTHOR, bodyMd: 'a human reply in a gov thread',
      bodyHtml: '<p>a human reply in a gov thread</p>', now: replyAt, parentPostId: mirror.id,
    });
    const afterReplyGrace = replyAt + EDIT_GRACE_MS + 1000;
    expect((await reconcilePostDocs(db(), reply.id, { ...OPTS, now: afterReplyGrace })).status).toBe('created');
  });

  it('skips the sync-written mirror post of a survey topic', async () => {
    // A survey's opening post reproduces the CIP-179 record, which is its own
    // anchored on-chain document; emitting a CIP-100 document for it would
    // publish DRepTalk's rendering of somebody else's record.
    const { firstPost } = await seedTopic('r15', 'survey');
    expect((await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE })).status).toBe(
      'skipped',
    );
    // Nor may it occupy a slot in the cron's bounded batch.
    expect(await findStalePostIds(db(), AFTER_GRACE, 50)).not.toContain(firstPost.id);
  });

  it('emits a human reply inside a survey topic', async () => {
    const { topic, firstPost } = await seedTopic('r16', 'survey');
    const reply = await createPost(db(), {
      topicId: topic.id, authorId: AUTHOR, bodyMd: 'a human reply in a survey thread',
      bodyHtml: '<p>a human reply in a survey thread</p>', now: T + 1000, parentPostId: firstPost.id,
    });
    const at = T + 1000 + EDIT_GRACE_MS + 1000;
    expect((await reconcilePostDocs(db(), reply.id, { ...OPTS, now: at })).status).toBe('created');
    expect(await findStalePostIds(db(), at - EDIT_GRACE_MS, 50)).not.toContain(firstPost.id);
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

  it('emits nothing for a post hidden by community flags', async () => {
    const { firstPost } = await seedTopic('r13');
    await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(firstPost.id).run();
    const res = await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    expect(res.status).toBe('skipped');
    expect(await getHeadDoc(db(), firstPost.id)).toBeNull();
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
      guard: { bodyMd: 'a racing edit', editedAt: AFTER_GRACE + 2000 },
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

  // The dangerous race is not a taken version slot, it is an edit that lands
  // between reading the post and writing the document. The reconciler would
  // otherwise publish the pre-edit text as the newest version, and an immutable
  // snapshot carrying superseded text cannot be repaired. Interleaved for real:
  // the edit fires from inside the head read, after the post was loaded.
  it('never publishes pre-edit text when an edit lands mid-build', async () => {
    const { firstPost } = await seedTopic('r10b');
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    // A first edit, so the reconcile below has real work and reaches the insert
    // rather than stopping at the no-op rule.
    await editPost(db(), {
      postId: firstPost.id, authorId: AUTHOR, bodyMd: 'the edit that lost',
      bodyHtml: '<p>the edit that lost</p>', now: AFTER_GRACE + 1000, sessionGrantId: null,
    });

    let fired = false;
    const racing = new Proxy(db(), {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (fired || !sql.includes('ORDER BY version DESC')) return stmt;
          fired = true;
          return new Proxy(stmt, {
            get(sTarget, sProp, sReceiver) {
              if (sProp !== 'bind') return Reflect.get(sTarget, sProp, sReceiver);
              return (...args: unknown[]) => {
                const bound = sTarget.bind(...args);
                return new Proxy(bound, {
                  get(bTarget, bProp, bReceiver) {
                    if (bProp !== 'first') return Reflect.get(bTarget, bProp, bReceiver);
                    return async () => {
                      await editPost(db(), {
                        postId: firstPost.id, authorId: AUTHOR, bodyMd: 'the edit that won',
                        bodyHtml: '<p>the edit that won</p>', now: AFTER_GRACE + 2000, sessionGrantId: null,
                      });
                      return bTarget.first();
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as D1Database;

    const res = await reconcilePostDocs(racing, firstPost.id, { ...OPTS, now: AFTER_GRACE + 3000 });
    expect(res.status).toBe('created');
    const head = await getHeadDoc(db(), firstPost.id);
    expect(head?.version).toBe(2);
    const body = JSON.parse((await getDocBody(db(), head?.hash ?? '')) ?? '{}');
    expect(body.body.comment).toBe('the edit that won');
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

  it('a later reply version still points at the parent snapshot it was written against', async () => {
    const { topic, firstPost } = await seedTopic('r12');
    // Parent v1: reconcile the opening post past its own grace window.
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: AFTER_GRACE });
    const parentV1 = await getHeadDoc(db(), firstPost.id);
    expect(parentV1).not.toBeNull();

    // The reply is created after parent v1 already exists.
    const replyCreatedAt = AFTER_GRACE + 2000;
    const reply = await createPost(db(), {
      topicId: topic.id, authorId: AUTHOR, bodyMd: 'a reply to v1',
      bodyHtml: '<p>a reply to v1</p>', now: replyCreatedAt, parentPostId: firstPost.id,
    });
    // Reply v1: reconcile strictly past the reply's own grace window (the
    // boundary is inclusive, see the earlier grace-boundary fix).
    const replyReconcile1At = replyCreatedAt + EDIT_GRACE_MS + 1000;
    const res1 = await reconcilePostDocs(db(), reply.id, { ...OPTS, now: replyReconcile1At });
    expect(res1.status).toBe('created');
    const doc1 = JSON.parse((await getDocBody(db(), res1.hash as string)) as string) as {
      body: { inReplyTo?: string };
    };
    expect(doc1.body.inReplyTo).toBe(`${OPTS.origin}/cip100/${parentV1?.hash}.json`);

    // Edit the parent with genuinely different markdown, so parent v2 exists
    // and is newer than the reply.
    const editParentAt = replyReconcile1At + 1000;
    await editPost(db(), {
      postId: firstPost.id, authorId: AUTHOR, bodyMd: 'a genuinely different parent body',
      bodyHtml: '<p>a genuinely different parent body</p>', now: editParentAt, sessionGrantId: null,
    });
    const reconcileParent2At = editParentAt + 1000;
    await reconcilePostDocs(db(), firstPost.id, { ...OPTS, now: reconcileParent2At });
    const parentV2 = await getHeadDoc(db(), firstPost.id);
    expect(parentV2?.version).toBe(2);
    expect(parentV2?.createdAt).toBeGreaterThan(reply.created_at);

    // Edit the reply itself with genuinely different markdown and reconcile
    // it again.
    const editReplyAt = reconcileParent2At + 1000;
    await editPost(db(), {
      postId: reply.id, authorId: AUTHOR, bodyMd: 'a genuinely different reply body',
      bodyHtml: '<p>a genuinely different reply body</p>', now: editReplyAt, sessionGrantId: null,
    });
    const reconcileReply2At = editReplyAt + 1000;
    const res2 = await reconcilePostDocs(db(), reply.id, { ...OPTS, now: reconcileReply2At });
    expect(res2.status).toBe('created');
    const doc2 = JSON.parse((await getDocBody(db(), res2.hash as string)) as string) as {
      body: { inReplyTo?: string };
    };
    // Reply v2 must still point at parent v1, the snapshot that existed when
    // the reply was written, never at parent v2 which postdates the reply.
    expect(doc2.body.inReplyTo).toBe(`${OPTS.origin}/cip100/${parentV1?.hash}.json`);
  });
});

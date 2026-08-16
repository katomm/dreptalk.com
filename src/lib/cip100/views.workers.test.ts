// src/lib/cip100/views.workers.test.ts
// The version index is one of the two mutable documents: built live from D1
// on every request. These tests pin the two things easy to get wrong: the
// tombstone must replace the whole body, and deletedAt must never be invented.
import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost, editPost } from '../db/forum.js';
import { getDocBody, getDocForServe, getHeadDoc } from '../db/cip100.js';
import { reconcilePostDocs } from './reconcile.js';
import { buildVersionIndex, buildThreadManifest, buildCitationView } from './views.js';
import { isoSeconds } from './document.js';
import { EDIT_GRACE_MS } from '../forum/editPolicy.js';

const db = () => env.DB;
const T = 1_700_000_000_000;
const AFTER_GRACE = T + EDIT_GRACE_MS + 1000;
const ORIGIN = 'https://dreptalk.com';

it('lists versions and marks the current one', async () => {
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-views', title: 'Version index',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'v1',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  const res = await buildVersionIndex(db(), firstPost.id, ORIGIN);
  expect(res.status).toBe(200);
  const doc = JSON.parse(res.body as string);
  expect(doc.status).toBe('published');
  expect(doc.versions).toHaveLength(1);
  expect(doc.current).toBe(doc.versions[0].hash);
});

it('replaces the whole body with a tombstone once deleted', async () => {
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-views', title: 'Version index deleted',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'v2',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T + 99, firstPost.id).run();
  const doc = JSON.parse((await buildVersionIndex(db(), firstPost.id, ORIGIN)).body as string);
  expect(doc.status).toBe('deleted');
  expect(doc.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(doc.versions).toHaveLength(1);
  expect(JSON.stringify(doc)).not.toContain('postedBy');
  expect('permalink' in doc).toBe(false);
  expect('thread' in doc).toBe(false);
  // The exact key set, not just the fields we happened to name, so a newly
  // leaked field fails this test whether or not anyone thought to name it.
  expect(Object.keys(doc).sort()).toEqual(
    ['@context', '@type', 'deletedAt', 'postId', 'status', 'versions'].sort(),
  );
});

it('omits deletedAt when the flag was set without a timestamp', async () => {
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-views', title: 'Version index no ts',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'v3',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  await db().prepare('UPDATE posts SET deleted = 1 WHERE id = ?').bind(firstPost.id).run();
  const doc = JSON.parse((await buildVersionIndex(db(), firstPost.id, ORIGIN)).body as string);
  expect(doc.status).toBe('deleted');
  expect('deletedAt' in doc).toBe(false);
});

it('dates a tombstone from the earliest active deletion, not the post one', async () => {
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-views', title: 'Tombstone date',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'td1',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  // Thread deleted first, post flagged nineteen days later.
  const THREAD_AT = T;
  const POST_AT = T + 19 * 24 * 60 * 60 * 1000;
  await db().prepare('UPDATE topics SET deleted = 1, deleted_at = ? WHERE id = ?')
    .bind(THREAD_AT, topic.id).run();
  await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?')
    .bind(POST_AT, firstPost.id).run();

  const res = await buildVersionIndex(db(), firstPost.id, ORIGIN);
  const doc = JSON.parse(res.body as string);
  // The retention sweep uses the thread's date, so the published one must match.
  expect(doc.deletedAt).toBe(isoSeconds(THREAD_AT));
});

it('404s an unknown post', async () => {
  expect((await buildVersionIndex(db(), 'no-such-post', ORIGIN)).status).toBe(404);
});

it('lists posts in thread order with flat readable keys', async () => {
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-manifest', title: 'Manifest order',
    bodyMd: 'opening', bodyHtml: '<p>opening</p>', now: T, rand: 'm1',
  });
  const replyPostedAt = T + 1000;
  const reply = await createPost(db(), {
    topicId: topic.id, authorId: 'test-author-manifest', bodyMd: 'reply',
    bodyHtml: '<p>reply</p>', now: replyPostedAt, parentPostId: firstPost.id,
  });
  // Reconcile strictly past the reply's own grace window, not just
  // AFTER_GRACE (which is exactly at the reply's boundary, still in grace
  // per isWithinGrace's <=, and would silently skip its document).
  const afterReplyGrace = replyPostedAt + EDIT_GRACE_MS + 1000;
  for (const id of [firstPost.id, reply.id]) {
    await reconcilePostDocs(db(), id, { origin: ORIGIN, network: 'mainnet', now: afterReplyGrace });
  }
  const doc = JSON.parse((await buildThreadManifest(db(), topic.id, ORIGIN, 'mainnet')).body as string);
  expect(doc.title).toBe('Manifest order');
  expect(doc.discussion).toBe(`${ORIGIN}/t/${topic.slug}/`);
  expect(doc.posts.map((p: { postId: string }) => p.postId)).toEqual([firstPost.id, reply.id]);
  expect(doc.posts[1].inReplyToPostId).toBe(firstPost.id);
  // The manifest must name its network, or a consumer cannot tell a preprod
  // thread from a mainnet one.
  expect(doc.network).toBe('mainnet');
  expect(JSON.stringify(doc)).not.toContain('reaction');
});

it('tombstones a deleted post and drops its identity', async () => {
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-manifest', title: 'Manifest tombstone',
    bodyMd: 'opening', bodyHtml: '<p>opening</p>', now: T, rand: 'm2',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T + 5, firstPost.id).run();
  const doc = JSON.parse((await buildThreadManifest(db(), topic.id, ORIGIN, 'mainnet')).body as string);
  expect(doc.posts[0].status).toBe('deleted');
  expect('postedBy' in doc.posts[0]).toBe(false);
  expect('permalink' in doc.posts[0]).toBe(false);
});

it('410s a deleted thread', async () => {
  const { topic } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-manifest', title: 'Manifest gone',
    bodyMd: 'opening', bodyHtml: '<p>opening</p>', now: T, rand: 'm3',
  });
  await db().prepare('UPDATE topics SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T + 5, topic.id).run();
  expect((await buildThreadManifest(db(), topic.id, ORIGIN, 'mainnet')).status).toBe(410);
});

it('withholds a post hidden after its document was emitted, and serves it again once un-hidden', async () => {
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-views', title: 'Manifest hidden',
    bodyMd: 'opening', bodyHtml: '<p>opening</p>', now: T, rand: 'v4',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  const head = await getHeadDoc(db(), firstPost.id);
  const hash = head?.hash as string;

  await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(firstPost.id).run();
  // 404 on both mutable documents, never a tombstone: hiding is not deletion.
  expect((await buildVersionIndex(db(), firstPost.id, ORIGIN)).status).toBe(404);
  const hiddenManifest = JSON.parse((await buildThreadManifest(db(), topic.id, ORIGIN, 'mainnet')).body as string);
  expect(hiddenManifest.posts).toEqual([]);
  expect(JSON.stringify(hiddenManifest)).not.toContain(firstPost.id);
  expect((await getDocForServe(db(), hash))?.state).toBe('hidden');

  // Withdrawing the flags restores all three surfaces. Nothing was destroyed,
  // which is the whole difference between hiding and deleting.
  await db().prepare('UPDATE posts SET hidden = 0 WHERE id = ?').bind(firstPost.id).run();
  expect((await buildVersionIndex(db(), firstPost.id, ORIGIN)).status).toBe(200);
  const backManifest = JSON.parse((await buildThreadManifest(db(), topic.id, ORIGIN, 'mainnet')).body as string);
  expect(backManifest.posts.map((p: { postId: string }) => p.postId)).toEqual([firstPost.id]);
  expect(await getDocForServe(db(), hash)).toEqual({ body: expect.any(String), state: 'available' });
});

it('still publishes the deletion record for a post that was hidden and then deleted', async () => {
  // Hiding is recomputed only when someone flags or unflags, and nobody flags an
  // invisible post, so a hidden post stays hidden and can then be deleted by
  // hand. Deletion has to win on every surface, or the consumer holding the
  // citation gets "gone, stop asking" from one and "no such thing" from another,
  // and the deletion record the guide promises is never published.
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-views', title: 'Hidden then deleted',
    bodyMd: 'opening', bodyHtml: '<p>opening</p>', now: T, rand: 'v6',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  const hash = (await getHeadDoc(db(), firstPost.id))?.hash as string;
  await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(firstPost.id).run();
  await db()
    .prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?')
    .bind(T + 7, firstPost.id)
    .run();

  const index = await buildVersionIndex(db(), firstPost.id, ORIGIN);
  expect(index.status).toBe(200);
  const indexDoc = JSON.parse(index.body as string);
  expect(indexDoc.status).toBe('deleted');
  expect(indexDoc.versions).toHaveLength(1);
  expect(JSON.stringify(indexDoc)).not.toContain('postedBy');

  const manifest = JSON.parse((await buildThreadManifest(db(), topic.id, ORIGIN, 'mainnet')).body as string);
  expect(manifest.posts).toHaveLength(1);
  expect(manifest.posts[0].status).toBe('deleted');
  expect('postedBy' in manifest.posts[0]).toBe(false);

  // And the snapshot stays on the erasure path, not the reversible one.
  expect((await getDocForServe(db(), hash))?.state).toBe('gone');
});

// The only place a role writes into immutable bytes: a wrong profile URL here
// is published forever. Every other test uses a bare author id with no users
// row, so profile stays null and the id-form URL is never built.
it('carries the right postedBy for a DRep, an SPO and an author with neither', async () => {
  await db()
    .prepare(
      `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at, slug, name)
       VALUES ('drep1role', 'registered', 1, 0, 0, 'role-drep', 'Role DRep')`,
    )
    .run();
  await db()
    .prepare("INSERT INTO pools (pool_id, ticker, name) VALUES ('pool1role', 'ROLE', 'Role Pool')")
    .run();
  for (const [id, col, value] of [
    ['user-role-drep', 'drep_id', 'drep1role'],
    ['user-role-spo', 'pool_id', 'pool1role'],
    ['user-role-delegator', 'stake_addr', 'stake_test1role'],
  ] as const) {
    await db()
      .prepare(`INSERT INTO users (id, ${col}, created_at, last_verified_at) VALUES (?, ?, 0, 0)`)
      .bind(id, value)
      .run();
  }

  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'user-role-drep', title: 'Manifest roles',
    bodyMd: 'drep post', bodyHtml: '<p>drep post</p>', now: T, rand: 'v5',
  });
  const spoPost = await createPost(db(), {
    topicId: topic.id, authorId: 'user-role-spo', bodyMd: 'spo post',
    bodyHtml: '<p>spo post</p>', now: T + 1000,
  });
  const plainPost = await createPost(db(), {
    topicId: topic.id, authorId: 'user-role-delegator', bodyMd: 'delegator post',
    bodyHtml: '<p>delegator post</p>', now: T + 2000,
  });

  const at = T + 2000 + EDIT_GRACE_MS + 1000;
  const emitted: Record<string, { handle: string; profile?: string; drepId?: string; poolId?: string }> = {};
  for (const id of [firstPost.id, spoPost.id, plainPost.id]) {
    const res = await reconcilePostDocs(db(), id, { origin: ORIGIN, network: 'mainnet', now: at });
    expect(res.status).toBe('created');
    const doc = JSON.parse((await getDocBody(db(), res.hash as string)) as string);
    emitted[id] = doc.body.postedBy;
  }

  const manifest = JSON.parse((await buildThreadManifest(db(), topic.id, ORIGIN, 'mainnet')).body as string);
  const listed: Record<string, { handle: string; profile?: string; drepId?: string; poolId?: string }> =
    Object.fromEntries(manifest.posts.map((p: { postId: string; postedBy: unknown }) => [p.postId, p.postedBy]));

  // The emitted document and the manifest must agree, or a consumer reading
  // one and verifying against the other sees a contradiction.
  for (const [postId, expected] of [
    [firstPost.id, { handle: 'Role DRep', profile: `${ORIGIN}/dreps/drep1role/`, drepId: 'drep1role' }],
    [spoPost.id, { handle: 'Role Pool', profile: `${ORIGIN}/spos/pool1role/`, poolId: 'pool1role' }],
  ] as const) {
    expect(emitted[postId]).toEqual(expected);
    expect(listed[postId]).toEqual(expected);
  }

  // An author with neither omits the fields rather than emitting null, and the
  // slug is never used: ids cannot change, slugs can.
  expect(Object.keys(emitted[plainPost.id])).toEqual(['handle']);
  expect(Object.keys(listed[plainPost.id])).toEqual(['handle']);
  expect(JSON.stringify(manifest)).not.toContain('role-drep');
});

// The citation page at /cite/<postId>/ is the readable form of the version
// index. It shares one live read with the JSON, so these tests pin what the
// page adds on top: the ordering a reader sees, the identity it names, and the
// fact that a deleted post says less here than the JSON tombstone does, not more.
it('lists versions newest first, marks the current one, and names post and author', async () => {
  await db()
    .prepare("INSERT INTO users (id, display_name, created_at, last_verified_at) VALUES ('user-cite', 'Cite Author', 0, 0)")
    .run();
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'user-cite', title: 'Citation page',
    bodyMd: 'first body', bodyHtml: '<p>first body</p>', now: T, rand: 'cv1',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  await editPost(db(), {
    postId: firstPost.id, authorId: 'user-cite', bodyMd: 'a genuinely different body',
    bodyHtml: '<p>a genuinely different body</p>', now: AFTER_GRACE + 2000, sessionGrantId: null,
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE + 3000 });

  const view = await buildCitationView(db(), firstPost.id, ORIGIN);
  if (view.status !== 200) throw new Error(`expected 200, got ${view.status}`);
  expect(view.topicTitle).toBe('Citation page');
  // Site-relative, so a reader on preprod or a dev host is not sent to mainnet.
  expect(view.permalink).toBe(`/t/${topic.slug}/#post-${firstPost.id}`);
  // The handle comes from the head document, not from a live profile read, so
  // the page and the documents it lists can never name different authors.
  expect(view.handle).toBe('Cite Author');
  expect(view.indexUri).toBe(`${ORIGIN}/cip100/post/${firstPost.id}.json`);
  // Newest first, and only the head is flagged current: the template renders
  // the flag rather than re-deriving "current" from the ordering.
  expect(view.versions.map((v) => v.version)).toEqual([2, 1]);
  expect(view.versions.map((v) => v.current)).toEqual([true, false]);

  // The page and the JSON are two renderings of one read. If they ever listed
  // different addresses, citing from the page would be citing something else.
  const index = JSON.parse((await buildVersionIndex(db(), firstPost.id, ORIGIN)).body as string);
  expect(view.versions.map((v) => v.uri)).toEqual(
    index.versions.map((v: { uri: string }) => v.uri).reverse(),
  );
  expect(view.versions[0].uri).toBe(`${ORIGIN}/cip100/${index.current}.json`);
});

it('410s a deleted post and shows nothing but the tombstone', async () => {
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-views', title: 'Citation deleted',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'cv2',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T + 99, firstPost.id).run();

  const view = await buildCitationView(db(), firstPost.id, ORIGIN);
  if (view.status !== 410) throw new Error(`expected 410, got ${view.status}`);
  expect(view.deletedAt).toBe(T + 99);
  expect(view.versionCount).toBe(1);
  // The exact key set, not just the fields we happened to name: no title, no
  // author, no hashes, so a newly leaked field fails this whether or not
  // anyone thought to name it.
  expect(Object.keys(view).sort()).toEqual(['deletedAt', 'status', 'versionCount'].sort());
});

it('leaves deletedAt null when the flag was set without a timestamp', async () => {
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-views', title: 'Citation deleted no ts',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'cv3',
  });
  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  await db().prepare('UPDATE posts SET deleted = 1 WHERE id = ?').bind(firstPost.id).run();

  const view = await buildCitationView(db(), firstPost.id, ORIGIN);
  if (view.status !== 410) throw new Error(`expected 410, got ${view.status}`);
  // Null, never a stand-in date: the page omits the sentence rather than
  // stating a deletion time nobody recorded.
  expect(view.deletedAt).toBeNull();
});

it('404s a hidden post, an unknown post and a post with no documents', async () => {
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-views', title: 'Citation hidden',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'cv4',
  });
  // No documents emitted yet: nothing to cite, and no page.
  expect((await buildCitationView(db(), firstPost.id, ORIGIN)).status).toBe(404);

  await reconcilePostDocs(db(), firstPost.id, { origin: ORIGIN, network: 'mainnet', now: AFTER_GRACE });
  await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(firstPost.id).run();
  // 404, never 410: hiding is reversible, and a Gone answer would claim a
  // permanent erasure that has not happened.
  expect((await buildCitationView(db(), firstPost.id, ORIGIN)).status).toBe(404);

  expect((await buildCitationView(db(), 'no-such-post', ORIGIN)).status).toBe(404);
});

it('serves an empty posts array for a thread with no eligible posts', async () => {
  const { topic } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-manifest', title: 'Manifest empty',
    bodyMd: 'opening', bodyHtml: '<p>opening</p>', source: 'governance', now: T, rand: 'm4',
  });
  const doc = JSON.parse((await buildThreadManifest(db(), topic.id, ORIGIN, 'mainnet')).body as string);
  expect(doc.posts).toEqual([]);
});

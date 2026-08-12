// src/lib/cip100/views.workers.test.ts
// The version index is one of the two mutable documents: built live from D1
// on every request. These tests pin the two things easy to get wrong: the
// tombstone must replace the whole body, and deletedAt must never be invented.
import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from '../db/forum.js';
import { reconcilePostDocs } from './reconcile.js';
import { buildVersionIndex } from './views.js';
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

it('404s an unknown post', async () => {
  expect((await buildVersionIndex(db(), 'no-such-post', ORIGIN)).status).toBe(404);
});

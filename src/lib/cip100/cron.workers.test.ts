// src/lib/cip100/cron.workers.test.ts
// The cron phase: erasure sweep first, then a bounded reconcile batch. These
// tests pin the two things that are easy to get wrong: that a run backfills
// version 1 for posts past their grace window, and that a post deleted
// between runs is purged and stamped rather than reconciled back into
// existence.
import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from '../db/forum.js';
import { getHeadDoc } from '../db/cip100.js';
import { runCip100Sync } from './cron.js';
import { EDIT_GRACE_MS } from '../forum/editPolicy.js';

const db = () => env.DB;
const T = 1_700_000_000_000;
const AFTER_GRACE = T + EDIT_GRACE_MS + 1000;

it('materializes version 1 for posts past their grace window', async () => {
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-cron', title: 'Cron backfill',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'c1',
  });
  const res = await runCip100Sync(db(), { origin: 'https://dreptalk.com', network: 'mainnet', now: AFTER_GRACE, limit: 50 });
  expect(res.reconciled).toBeGreaterThan(0);
  expect((await getHeadDoc(db(), firstPost.id))?.version).toBe(1);
});

it('purges bytes and stamps a missing deletion time', async () => {
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-cron', title: 'Cron purge',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'c2',
  });
  await runCip100Sync(db(), { origin: 'https://dreptalk.com', network: 'mainnet', now: AFTER_GRACE, limit: 50 });
  await db().prepare('UPDATE posts SET deleted = 1 WHERE id = ?').bind(firstPost.id).run();
  const res = await runCip100Sync(db(), { origin: 'https://dreptalk.com', network: 'mainnet', now: AFTER_GRACE + 60_000, limit: 50 });
  expect(res.purged).toBe(1);
  const row = await db().prepare('SELECT deleted_at FROM posts WHERE id = ?').bind(firstPost.id).first<{ deleted_at: number }>();
  expect(row?.deleted_at).toBe(AFTER_GRACE + 60_000);
});

it('stamps a manually deleted topic too, so its post tombstones can date themselves', async () => {
  const { topic } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-cron', title: 'Cron topic purge',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'c3',
  });
  await db().prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(topic.id).run();
  await runCip100Sync(db(), { origin: 'https://dreptalk.com', network: 'mainnet', now: AFTER_GRACE + 120_000, limit: 50 });
  const row = await db().prepare('SELECT deleted_at FROM topics WHERE id = ?').bind(topic.id).first<{ deleted_at: number }>();
  expect(row?.deleted_at).toBe(AFTER_GRACE + 120_000);
});

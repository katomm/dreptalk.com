// src/lib/cip100/cron.workers.test.ts
// The cron phase: a bounded reconcile batch. These tests pin the two things
// that are easy to get wrong: that a run backfills version 1 for posts past
// their grace window, and that a deleted post is never reconciled back into
// existence. Erasure itself moved to src/lib/db/postErasure.ts and is tested
// there.
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

it('keeps permanently out-of-scope posts from starving the batch', async () => {
  // The batch is bounded and ordered by created_at, so a candidate that can
  // never be satisfied is not merely wasted work: it holds its slot on every
  // run. Seed more of them than fit in one batch, all older than one ordinary
  // post, which is the state that used to stop every later post from ever
  // getting a document.
  const LIMIT = 3;
  const OLD = T - 1_000_000;
  for (let i = 0; i < LIMIT - 1; i++) {
    // Governance opening post: mirrors on-chain content, never emitted.
    await createTopic(db(), {
      categorySlug: 'general', authorId: 'test-author-cron', title: `Cron starve gov ${i}`,
      bodyMd: 'body', bodyHtml: '<p>body</p>', source: 'governance', now: OLD, rand: `s${i}`,
    });
  }
  // Vote-rationale cross-post: references its own on-chain document, never emitted.
  const rationale = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-cron', title: 'Cron starve rationale',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: OLD, rand: 'sr',
  });
  await db().prepare("UPDATE posts SET source = 'vote_rationale' WHERE id = ?").bind(rationale.firstPost.id).run();

  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-cron', title: 'Cron starve ordinary',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: OLD + 1000, rand: 'so',
  });

  const res = await runCip100Sync(db(), {
    origin: 'https://dreptalk.com', network: 'mainnet', now: AFTER_GRACE, limit: LIMIT,
  });
  expect((await getHeadDoc(db(), firstPost.id))?.version).toBe(1);
  expect(res.reconciled).toBeGreaterThan(0);
  // And the unsatisfiable ones are gone from the candidate set entirely, rather
  // than being fetched and then skipped one by one.
  expect(res.skipped).toBe(0);
});

it('never reconciles a deleted post back into existence', async () => {
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: 'test-author-cron', title: 'Cron deleted skip',
    bodyMd: 'body', bodyHtml: '<p>body</p>', now: T, rand: 'c2',
  });
  await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, firstPost.id).run();
  await runCip100Sync(db(), { origin: 'https://dreptalk.com', network: 'mainnet', now: AFTER_GRACE, limit: 50 });
  expect(await getHeadDoc(db(), firstPost.id)).toBeNull();
});

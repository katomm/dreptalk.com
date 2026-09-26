/// <reference types="@cloudflare/workers-types" />
// Post-flag tests -- run in real workerd via @cloudflare/vitest-pool-workers.
// Exercise flagPost / unflagPost / flaggedPostIdsStmts against the real D1 binding.
// Focus: per-writer dedup, the hide threshold, un-hiding on withdrawal, and the
// per-flagger flagged-id lookup.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, getPostById } from './forum.js';
import { flagPost, unflagPost, flaggedPostIdsStmts, FLAG_HIDE_THRESHOLD } from './postFlags.js';

const db = () => env.DB;
const NOW = 1_751_000_000_000;

let topicSeq = 0;
// Creates a fresh topic and returns its first post id (the post we flag).
async function newPostId(): Promise<string> {
  topicSeq++;
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general',
    authorId: 'author-x',
    title: `Flag fixture ${topicSeq}`,
    bodyMd: 'body',
    bodyHtml: '<p>body</p>',
    now: NOW,
    rand: `r${topicSeq}`,
  });
  return firstPost.id;
}

describe('flagPost', () => {
  it('counts distinct flaggers and is idempotent per flagger', async () => {
    const postId = await newPostId();

    const a1 = await flagPost(db(), { postId, flaggerId: 'drep-a', now: NOW });
    expect(a1.flagCount).toBe(1);
    expect(a1.hidden).toBe(false);

    // Same flagger again: no change.
    const a2 = await flagPost(db(), { postId, flaggerId: 'drep-a', now: NOW + 1 });
    expect(a2.flagCount).toBe(1);
    expect(a2.hidden).toBe(false);

    const b = await flagPost(db(), { postId, flaggerId: 'drep-b', now: NOW + 2 });
    expect(b.flagCount).toBe(2);
    expect(b.hidden).toBe(false);
  });

  it('hides the post once the threshold of distinct flaggers is reached', async () => {
    const postId = await newPostId();

    for (let i = 0; i < FLAG_HIDE_THRESHOLD - 1; i++) {
      const s = await flagPost(db(), { postId, flaggerId: `drep-${i}`, now: NOW });
      expect(s.hidden).toBe(false);
    }
    const last = await flagPost(db(), { postId, flaggerId: 'drep-final', now: NOW });
    expect(last.flagCount).toBe(FLAG_HIDE_THRESHOLD);
    expect(last.hidden).toBe(true);

    // The persisted post reflects the hidden state.
    const post = await getPostById(db(), postId);
    expect(post!.hidden).toBe(true);
    expect(post!.flag_count).toBe(FLAG_HIDE_THRESHOLD);
  });
});

describe('unflagPost', () => {
  it('un-hides when the count drops back below the threshold', async () => {
    const postId = await newPostId();
    for (let i = 0; i < FLAG_HIDE_THRESHOLD; i++) {
      await flagPost(db(), { postId, flaggerId: `drep-${i}`, now: NOW });
    }
    expect((await getPostById(db(), postId))!.hidden).toBe(true);

    const after = await unflagPost(db(), { postId, flaggerId: 'drep-0' });
    expect(after.flagCount).toBe(FLAG_HIDE_THRESHOLD - 1);
    expect(after.hidden).toBe(false);
    expect((await getPostById(db(), postId))!.hidden).toBe(false);
  });

  it('is a no-op when the flagger never flagged', async () => {
    const postId = await newPostId();
    await flagPost(db(), { postId, flaggerId: 'drep-a', now: NOW });
    const s = await unflagPost(db(), { postId, flaggerId: 'never-flagged' });
    expect(s.flagCount).toBe(1);
  });
});

describe('flaggedPostIdsStmts', () => {
  // The chunking and the 100-bind cap are covered through the thread view in
  // forum/viewerPostState.workers.test.ts. This case pins the per-flagger filter.
  it('selects only the posts this flagger flagged', async () => {
    const p1 = await newPostId();
    const p2 = await newPostId();
    const p3 = await newPostId();
    await flagPost(db(), { postId: p1, flaggerId: 'drep-z', now: NOW });
    await flagPost(db(), { postId: p3, flaggerId: 'drep-z', now: NOW });
    // A different flagger on p2 must not leak into drep-z's set.
    await flagPost(db(), { postId: p2, flaggerId: 'drep-other', now: NOW });

    const batched = await db().batch<{ post_id: string }>(flaggedPostIdsStmts(db(), 'drep-z', [p1, p2, p3]));
    const ids = new Set(batched.flatMap((r) => (r.results ?? []).map((row) => row.post_id)));
    expect(ids).toEqual(new Set([p1, p3]));
  });
});

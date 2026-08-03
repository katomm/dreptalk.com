/// <reference types="@cloudflare/workers-types" />
// Post-flag tests -- run in real workerd via @cloudflare/vitest-pool-workers.
// Exercise flagPost / unflagPost / getFlaggedPostIds against the real D1 binding.
// Focus: per-writer dedup, the hide threshold, un-hiding on withdrawal, and the
// batched flagged-id lookup.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, getPostById } from './forum.js';
import { flagPost, unflagPost, getFlaggedPostIds, FLAG_HIDE_THRESHOLD } from './postFlags.js';
import { bindCountingDb } from './__tests__/bindCountingDb.js';

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

describe('getFlaggedPostIds', () => {
  it('returns only the posts the flagger flagged, batched', async () => {
    const p1 = await newPostId();
    const p2 = await newPostId();
    const p3 = await newPostId();
    await flagPost(db(), { postId: p1, flaggerId: 'drep-z', now: NOW });
    await flagPost(db(), { postId: p3, flaggerId: 'drep-z', now: NOW });
    // A different flagger on p2 must not leak into drep-z's set.
    await flagPost(db(), { postId: p2, flaggerId: 'drep-other', now: NOW });

    const set = await getFlaggedPostIds(db(), 'drep-z', [p1, p2, p3]);
    expect(set.has(p1)).toBe(true);
    expect(set.has(p2)).toBe(false);
    expect(set.has(p3)).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns an empty set for empty input without querying', async () => {
    const set = await getFlaggedPostIds(db(), 'drep-z', []);
    expect(set.size).toBe(0);
  });
});

describe('getFlaggedPostIds bind cap', () => {
  it('stays under the D1 100-bind cap for a lookup of more than 100 post ids', async () => {
    // flaggerId occupies one bind, so 150 post ids would put a single statement
    // at 151 binds: over production D1's cap (unenforced in miniflare).
    const flagged = [await newPostId(), await newPostId(), await newPostId()];
    for (const id of flagged) {
      await flagPost(db(), { postId: id, flaggerId: 'drep-bindcap', now: NOW });
    }
    const ids = [...Array.from({ length: 150 }, (_, i) => `missing-post-${i}`), ...flagged];

    const counted = bindCountingDb(db());
    const got = await getFlaggedPostIds(counted.db, 'drep-bindcap', ids);

    expect(got).toEqual(new Set(flagged));
    expect(counted.maxBinds()).toBeLessThanOrEqual(100);
  });
});

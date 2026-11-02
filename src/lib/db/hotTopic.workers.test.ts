// src/lib/db/hotTopic.workers.test.ts
/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost, getMostRepliedRecentTopic } from './forum.js';

const db = () => env.DB;
// Far from every other fixture's clock, so their topics never enter the window.
const NOW = 9_000_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const SINCE = NOW - WEEK;

let seq = 0;
async function topicWithPosts(title: string, posts: { authorId: string; at: number }[]) {
  seq++;
  const [first, ...rest] = posts;
  const { topic } = await createTopic(db(), {
    categorySlug: 'general', authorId: first.authorId, title,
    bodyMd: 'x', bodyHtml: '<p>x</p>', source: 'user', now: first.at, rand: `hot${seq}`,
  });
  for (const p of rest) {
    await createPost(db(), { topicId: topic.id, authorId: p.authorId, bodyMd: 'r', bodyHtml: '<p>r</p>', now: p.at });
  }
  return topic;
}

describe('getMostRepliedRecentTopic', () => {
  it('ranks by posts inside the window, not by the lifetime post count', async () => {
    const old = NOW - 3 * WEEK;
    // Long thread: six old posts plus one this week.
    await topicWithPosts('Long old thread', [
      ...Array.from({ length: 6 }, (_, i) => ({ authorId: `hot-old-${i}`, at: old + i })),
      { authorId: 'hot-old-0', at: NOW - 1000 },
    ]);
    // New thread: four posts, all this week.
    const fresh = await topicWithPosts('Fresh busy thread', Array.from({ length: 4 }, (_, i) => ({ authorId: `hot-new-${i}`, at: SINCE + 1000 + i })));

    const hot = await getMostRepliedRecentTopic(db(), SINCE);
    expect(hot?.id).toBe(fresh.id);
  });
});

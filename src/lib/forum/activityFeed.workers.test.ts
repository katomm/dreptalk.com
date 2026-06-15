/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost } from '../db/forum.js';
import { loadActivityFeed } from './activityFeed.js';

const db = () => env.DB;

describe('loadActivityFeed', () => {
  it('maps a forum reply to a commented/replied event with author and title', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'budget',
      authorId: 'user-a',
      title: 'Budget thread',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      now: 1000,
      rand: 'feed1',
    });
    await createPost(db(), {
      topicId: topic.id,
      authorId: 'user-b',
      bodyMd: 'r',
      bodyHtml: '<p>r</p>',
      now: 2000,
    });

    const feed = await loadActivityFeed(db(), { limit: 10 });

    // Newest first: the reply, then the topic creation.
    expect(feed[0].kind).toBe('reply_created');
    expect(feed[0].topic.title).toBe('Budget thread');
    expect(feed[0].topic.categoryName).toBe('Budget and Treasury');
    expect(feed[0].topic.isGovernance).toBe(false);
    expect(feed[0].refPostId).not.toBeNull();
    expect(feed[0].actor?.authorId).toBe('user-b');

    expect(feed[1].kind).toBe('topic_created');
    expect(feed[1].actor?.authorId).toBe('user-a');
  });

  it('drops events whose topic is deleted', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: 'user-c',
      title: 'Doomed',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      now: 3000,
      rand: 'feed2',
    });
    await db().prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(topic.id).run();

    const feed = await loadActivityFeed(db(), { limit: 10 });
    expect(feed.some((e) => e.topic.title === 'Doomed')).toBe(false);
  });
});

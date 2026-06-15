/// <reference types="@cloudflare/workers-types" />
// Activity event log tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { activityInsert, getRecentActivity } from './activity.js';
import { createTopic, createPost } from './forum.js';

const db = () => env.DB;

describe('activityInsert + getRecentActivity', () => {
  it('inserts a row and reads it back', async () => {
    await activityInsert(db(), {
      type: 'topic_created',
      topicId: 'topic-1',
      actorId: 'author-1',
      createdAt: 1000,
    }).run();

    const rows = await getRecentActivity(db(), { limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      type: 'topic_created',
      topic_id: 'topic-1',
      actor_id: 'author-1',
      ref_post_id: null,
      payload: null,
      created_at: 1000,
    });
  });

  it('serializes payload as JSON and leaves system actor null', async () => {
    await activityInsert(db(), {
      type: 'gov_status',
      topicId: 'topic-2',
      payload: { from: 'active', to: 'enacted' },
      createdAt: 2000,
    }).run();

    const rows = await getRecentActivity(db(), { limit: 10 });
    const row = rows.find((r) => r.topic_id === 'topic-2')!;
    expect(row.actor_id).toBeNull();
    expect(JSON.parse(row.payload as string)).toEqual({ from: 'active', to: 'enacted' });
  });

  it('orders newest first and respects the limit', async () => {
    await activityInsert(db(), { type: 'reply_created', topicId: 't', createdAt: 100 }).run();
    await activityInsert(db(), { type: 'reply_created', topicId: 't', createdAt: 300 }).run();
    await activityInsert(db(), { type: 'reply_created', topicId: 't', createdAt: 200 }).run();

    const rows = await getRecentActivity(db(), { limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows[0].created_at).toBe(300);
    expect(rows[1].created_at).toBe(200);
  });
});

describe('forum write paths emit activity', () => {
  it('createTopic emits one topic_created for a user topic', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: 'user-a',
      title: 'Hello',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      now: 5000,
      rand: 'act1',
    });

    const rows = await getRecentActivity(db(), { limit: 10 });
    const mine = rows.filter((r) => r.topic_id === topic.id);
    expect(mine.length).toBe(1);
    expect(mine[0]).toMatchObject({
      type: 'topic_created',
      actor_id: 'user-a',
      ref_post_id: null,
      created_at: 5000,
    });
  });

  it('createTopic emits NO activity for a governance topic', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'governance-actions',
      authorId: 'gov-sync',
      title: 'Gov',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      source: 'governance',
      now: 6000,
      rand: 'act2',
    });

    const rows = await getRecentActivity(db(), { limit: 10 });
    expect(rows.filter((r) => r.topic_id === topic.id).length).toBe(0);
  });

  it('createPost emits one reply_created with the post id', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: 'user-a',
      title: 'Thread',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      now: 7000,
      rand: 'act3',
    });
    const reply = await createPost(db(), {
      topicId: topic.id,
      authorId: 'user-b',
      bodyMd: 'r',
      bodyHtml: '<p>r</p>',
      now: 8000,
    });

    const rows = await getRecentActivity(db(), { limit: 10 });
    const replies = rows.filter((r) => r.topic_id === topic.id && r.type === 'reply_created');
    expect(replies.length).toBe(1);
    expect(replies[0]).toMatchObject({
      actor_id: 'user-b',
      ref_post_id: reply.id,
      created_at: 8000,
    });
  });
});

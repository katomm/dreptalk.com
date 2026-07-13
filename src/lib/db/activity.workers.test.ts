/// <reference types="@cloudflare/workers-types" />
// Activity event log tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { activityInsert, getRecentActivity, getActivityPage, insertGovStatusEventIfNew } from './activity.js';
import { createTopic, createPost } from './forum.js';

const db = () => env.DB;

describe('insertGovStatusEventIfNew', () => {
  it('records a transition once and dedups a repeat of the same (topic, target status)', async () => {
    await insertGovStatusEventIfNew(db(), { topicId: 'gtopic', from: 'active', to: 'enacted', createdAt: 100 });
    // Overlapping cron run (or re-run) reports the same transition: must not duplicate.
    await insertGovStatusEventIfNew(db(), { topicId: 'gtopic', from: 'active', to: 'enacted', createdAt: 200 });

    const gov = (await getRecentActivity(db(), { limit: 10 })).filter((r) => r.type === 'gov_status' && r.topic_id === 'gtopic');
    expect(gov.length).toBe(1);
    expect(gov[0].created_at).toBe(100); // the first-recorded event stands

    // A different target status is a distinct milestone and is recorded.
    await insertGovStatusEventIfNew(db(), { topicId: 'gtopic', from: 'ratified', to: 'expired', createdAt: 300 });
    const after = (await getRecentActivity(db(), { limit: 10 })).filter((r) => r.type === 'gov_status' && r.topic_id === 'gtopic');
    expect(after.length).toBe(2);
  });
});

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

describe('getActivityPage', () => {
  async function seedTopic(id: string, source: 'user' | 'governance', deleted = 0) {
    await db()
      .prepare(
        "INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted) VALUES (?, ?, 'a', ?, ?, ?, 1, 0, 0, ?)",
      )
      .bind(id, source === 'governance' ? 'governance-actions' : 'general', source, `T-${id}`, `t-${id}`, deleted)
      .run();
  }

  it('filters by type, excludes deleted topics, and returns a total', async () => {
    await seedTopic('gov1', 'governance');
    await seedTopic('forum1', 'user');
    await seedTopic('del1', 'user', 1);

    await db().batch([
      activityInsert(db(), { type: 'gov_created', topicId: 'gov1', createdAt: 100 }),
      activityInsert(db(), { type: 'gov_status', topicId: 'gov1', payload: { from: 'active', to: 'enacted' }, createdAt: 200 }),
      activityInsert(db(), { type: 'reply_created', topicId: 'forum1', actorId: 'a', refPostId: 'p1', createdAt: 300 }),
      activityInsert(db(), { type: 'topic_created', topicId: 'forum1', actorId: 'a', createdAt: 400 }),
      activityInsert(db(), { type: 'reply_created', topicId: 'del1', actorId: 'a', createdAt: 500 }),
    ]);

    const all = await getActivityPage(db(), { filter: 'all', limit: 50, offset: 0 });
    // del1's event is excluded (deleted topic); 4 remain, newest first.
    expect(all.total).toBe(4);
    expect(all.rows.map((r) => r.type)).toEqual(['topic_created', 'reply_created', 'gov_status', 'gov_created']);

    const gov = await getActivityPage(db(), { filter: 'governance', limit: 50, offset: 0 });
    expect(gov.total).toBe(2);
    expect(gov.rows.every((r) => r.type === 'gov_created' || r.type === 'gov_status')).toBe(true);

    const comments = await getActivityPage(db(), { filter: 'comments', limit: 50, offset: 0 });
    // Comments = human forum activity: new topics AND replies, not just replies.
    expect(comments.total).toBe(2);
    expect(comments.rows.map((r) => r.type)).toEqual(['topic_created', 'reply_created']);
    expect(comments.rows.every((r) => r.topic_id === 'forum1')).toBe(true);
  });

  it('paginates with limit and offset', async () => {
    await seedTopic('page', 'user');
    await db().batch([
      activityInsert(db(), { type: 'reply_created', topicId: 'page', actorId: 'a', createdAt: 1 }),
      activityInsert(db(), { type: 'reply_created', topicId: 'page', actorId: 'a', createdAt: 2 }),
      activityInsert(db(), { type: 'reply_created', topicId: 'page', actorId: 'a', createdAt: 3 }),
    ]);
    const page = await getActivityPage(db(), { filter: 'comments', limit: 2, offset: 0 });
    expect(page.rows.length).toBe(2);
    expect(page.total).toBe(3);
    const page2 = await getActivityPage(db(), { filter: 'comments', limit: 2, offset: 2 });
    expect(page2.rows.length).toBe(1);
  });
});

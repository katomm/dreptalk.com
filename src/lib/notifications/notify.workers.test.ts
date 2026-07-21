/// <reference types="@cloudflare/workers-types" />
// Reply fan-out and mention notification tests, run in real workerd.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { notifyReply, notifyMentions } from './notify.js';
import { getNotificationsPage } from '../db/notifications.js';
import { createTopic, createPost } from '../db/forum.js';

const db = () => env.DB;

async function seedThread() {
  // Topic by alice, replies by bob and alice; carol has a frozen vote rationale.
  const { topic } = await createTopic(db(), {
    categorySlug: 'general',
    authorId: 'alice',
    title: 'Test topic',
    bodyMd: 'hello',
    bodyHtml: '<p>hello</p>',
    source: 'user',
    now: 100,
    rand: 'abcde',
  });
  await createPost(db(), { topicId: topic.id, authorId: 'bob', bodyMd: 'hi', bodyHtml: '<p>hi</p>', now: 200 });
  // A crossposted vote rationale must NOT make its author a thread participant.
  await db()
    .prepare(
      `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at, source)
       VALUES ('rat1', ?, 'carol', 'r', '<p>r</p>', 300, 'vote_rationale')`,
    )
    .bind(topic.id)
    .run();
  return topic;
}

describe('notifyReply', () => {
  it('notifies the topic author and prior posters, excluding actor, rationale authors and gov-sync', async () => {
    const topic = await seedThread();
    const post = await createPost(db(), { topicId: topic.id, authorId: 'dave', bodyMd: 'x', bodyHtml: '<p>x</p>', now: 400 });
    await notifyReply(db(), { topicId: topic.id, postId: post.id, actorId: 'dave', now: 400 });

    expect((await getNotificationsPage(db(), 'alice', 10)).length).toBe(1);
    expect((await getNotificationsPage(db(), 'bob', 10)).length).toBe(1);
    expect((await getNotificationsPage(db(), 'carol', 10)).length).toBe(0);
    expect((await getNotificationsPage(db(), 'dave', 10)).length).toBe(0);

    const row = (await getNotificationsPage(db(), 'alice', 10))[0];
    expect(row.type).toBe('reply');
    expect(row.actor_id).toBe('dave');
    expect(row.topic_id).toBe(topic.id);
    expect(row.post_id).toBe(post.id);
  });

  it('honors excludeUserIds (mention recipients are not double-notified)', async () => {
    const topic = await seedThread();
    const post = await createPost(db(), { topicId: topic.id, authorId: 'dave', bodyMd: 'x', bodyHtml: '<p>x</p>', now: 400 });
    await notifyReply(db(), { topicId: topic.id, postId: post.id, actorId: 'dave', now: 400, excludeUserIds: ['bob'] });
    expect((await getNotificationsPage(db(), 'bob', 10)).length).toBe(0);
    expect((await getNotificationsPage(db(), 'alice', 10)).length).toBe(1);
  });
});

describe('notifyMentions', () => {
  it('writes mention rows, excluding the actor', async () => {
    await notifyMentions(db(), { mentionUserIds: ['bob', 'dave'], topicId: 't1', postId: 'p1', actorId: 'dave', now: 500 });
    expect((await getNotificationsPage(db(), 'bob', 10))[0].type).toBe('mention');
    expect((await getNotificationsPage(db(), 'dave', 10)).length).toBe(0);
  });
});

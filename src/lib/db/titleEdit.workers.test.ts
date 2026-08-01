// src/lib/db/titleEdit.workers.test.ts
/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, editTitle, getTopicBySlug } from './forum.js';

const db = () => env.DB;
const NOW = 1_752_000_000_000;
const AUTHOR = 'drep-titler-1';

let seq = 0;
async function newTopic(source: 'user' | 'governance' = 'user', proposerGrantId?: string | null) {
  seq++;
  const { topic } = await createTopic(db(), {
    categorySlug: 'general', authorId: AUTHOR, title: `Title fixture ${seq}`,
    bodyMd: 'b', bodyHtml: '<p>b</p>', source, now: NOW, rand: `tt${seq}`,
    proposerGrantId,
  });
  return topic;
}

describe('editTitle', () => {
  it('updates the title and sets title_edited_at, leaving the slug unchanged', async () => {
    const topic = await newTopic();
    await editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'A clearer title', now: NOW + 1000, sessionGrantId: null });
    const after = await getTopicBySlug(db(), topic.slug); // same slug still resolves
    expect(after?.title).toBe('A clearer title');
    const row = await db().prepare('SELECT title_edited_at FROM topics WHERE id = ?').bind(topic.id)
      .first<{ title_edited_at: number | null }>();
    expect(row?.title_edited_at).toBe(NOW + 1000);
  });

  it('throws not_owner for a non-author', async () => {
    const topic = await newTopic();
    await expect(editTitle(db(), { topicId: topic.id, authorId: 'someone', title: 'x', now: NOW, sessionGrantId: null }))
      .rejects.toThrow('not_owner');
  });

  it('throws not_user_topic for a governance topic', async () => {
    const topic = await newTopic('governance');
    await expect(editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'x', now: NOW, sessionGrantId: null }))
      .rejects.toThrow('not_user_topic');
  });

  it('throws topic_locked when locked', async () => {
    const topic = await newTopic();
    await db().prepare('UPDATE topics SET locked = 1 WHERE id = ?').bind(topic.id).run();
    await expect(editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'x', now: NOW, sessionGrantId: null }))
      .rejects.toThrow('topic_locked');
  });
});

describe('editTitle: mandate context match', () => {
  it('throws mandate_mismatch when a personal session edits a topic written under a mandate', async () => {
    const topic = await newTopic('user', 'grant-1');
    await expect(editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'x', now: NOW, sessionGrantId: null }))
      .rejects.toThrow('mandate_mismatch');
  });

  it('throws mandate_mismatch when a grant session edits a topic written without a mandate', async () => {
    const topic = await newTopic('user', null);
    await expect(editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'x', now: NOW, sessionGrantId: 'grant-1' }))
      .rejects.toThrow('mandate_mismatch');
  });

  it('a grant session edits its own mandate topic; stored proposer_grant_id unchanged', async () => {
    const topic = await newTopic('user', 'grant-1');
    await editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'Mandate title', now: NOW, sessionGrantId: 'grant-1' });
    const row = await db().prepare('SELECT title, proposer_grant_id FROM topics WHERE id = ?').bind(topic.id)
      .first<{ title: string; proposer_grant_id: string | null }>();
    expect(row?.title).toBe('Mandate title');
    expect(row?.proposer_grant_id).toBe('grant-1');
  });
});

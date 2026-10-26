// src/lib/db/titleEdit.workers.test.ts
/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, editTitle, getTopicBySlug } from './forum.js';

const db = () => env.DB;
const NOW = 1_752_000_000_000;
const AUTHOR = 'drep-titler-1';

let seq = 0;
async function newTopic(source: 'user' | 'governance' | 'survey' = 'user', proposerGrantId?: string | null) {
  seq++;
  const { topic } = await createTopic(db(), {
    categorySlug: 'general', authorId: AUTHOR, title: `Title fixture ${seq}`,
    bodyMd: 'b', bodyHtml: '<p>b</p>', source, now: NOW, rand: `tt${seq}`,
    proposerGrantId,
  });
  return topic;
}

// A real grant row for the stamped-row cases: editPost/editTitle check the
// stored grant in D1, so a bare id with no row counts as inactive.
async function insertGrant(id: string, coUserId: string, n: number, status: 'active' | 'revoked' = 'active') {
  await db()
    .prepare(
      `INSERT INTO proposer_grants
         (id, proposer_user_id, proposer_stake_addr, gov_action_id, co_user_id, co_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at)
       VALUES (?1, 'proposer-user', 'stake_test1editproposer', ?2, ?3, ?4, ?1, ?5, 0, 604800, 0)`,
    )
    .bind(id, `${'9e'.repeat(31)}${String(n).padStart(2, '0')}#0`, coUserId, `stake_test1co${coUserId}`, status)
    .run();
}

describe('editTitle', () => {
  it('updates the title and sets title_edited_at, leaving the slug unchanged', async () => {
    const topic = await newTopic();
    await editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'A clearer title', now: NOW + 1000, ownWriter: true });
    const after = await getTopicBySlug(db(), topic.slug); // same slug still resolves
    expect(after?.title).toBe('A clearer title');
    const row = await db().prepare('SELECT title_edited_at FROM topics WHERE id = ?').bind(topic.id)
      .first<{ title_edited_at: number | null }>();
    expect(row?.title_edited_at).toBe(NOW + 1000);
  });

  it('throws not_owner for a non-author', async () => {
    const topic = await newTopic();
    await expect(editTitle(db(), { topicId: topic.id, authorId: 'someone', title: 'x', now: NOW, ownWriter: true }))
      .rejects.toThrow('not_owner');
  });

  it('throws not_user_topic for a governance topic', async () => {
    const topic = await newTopic('governance');
    await expect(editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'x', now: NOW, ownWriter: true }))
      .rejects.toThrow('not_user_topic');
  });

  it('throws not_user_topic for a survey topic', async () => {
    const topic = await newTopic('survey');
    await expect(editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'x', now: NOW, ownWriter: true }))
      .rejects.toThrow('not_user_topic');
  });

  it('throws topic_locked when locked', async () => {
    const topic = await newTopic();
    await db().prepare('UPDATE topics SET locked = 1 WHERE id = ?').bind(topic.id).run();
    await expect(editTitle(db(), { topicId: topic.id, authorId: AUTHOR, title: 'x', now: NOW, ownWriter: true }))
      .rejects.toThrow('topic_locked');
  });
});

describe('editTitle: stamped grant', () => {
  const edit = (topicId: string, ownWriter: boolean, title = 'A new title') =>
    editTitle(db(), { topicId, authorId: AUTHOR, title, now: NOW, ownWriter });

  it('edits a stamped topic while exactly its grant is active, without an own writer role', async () => {
    await insertGrant('te-grant-active', AUTHOR, 11);
    const topic = await newTopic('user', 'te-grant-active');
    await edit(topic.id, false, 'Mandate title');
    const row = await db().prepare('SELECT title, proposer_grant_id FROM topics WHERE id = ?').bind(topic.id)
      .first<{ title: string; proposer_grant_id: string | null }>();
    expect(row?.title).toBe('Mandate title');
    expect(row?.proposer_grant_id).toBe('te-grant-active');
  });

  it('throws mandate_mismatch on a stamped topic whose grant was revoked, even for an own writer', async () => {
    await insertGrant('te-grant-revoked', AUTHOR, 12, 'revoked');
    const topic = await newTopic('user', 'te-grant-revoked');
    await expect(edit(topic.id, true)).rejects.toThrow('mandate_mismatch');
  });

  it('throws mandate_mismatch on an unstamped topic without an own writer role', async () => {
    const topic = await newTopic('user', null);
    await expect(edit(topic.id, false)).rejects.toThrow('mandate_mismatch');
  });
});

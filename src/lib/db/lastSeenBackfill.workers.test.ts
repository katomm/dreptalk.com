import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { LAST_SEEN_BACKFILL_SQL } from './lastSeenBackfill.js';

const SEC = 1_700_000_000; // last_verified_at is seconds
const MS = SEC * 1000;

// last_verified_at is NOT NULL in the real schema, so the helper takes a number.
async function seedUser(id: string, lastVerifiedSec: number) {
  await env.DB.prepare(
    `INSERT INTO users (id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at, last_seen)
     VALUES (?, 0, 0, 0, 0, 'member', 'active', 0, ?, NULL)`,
  ).bind(id, lastVerifiedSec).run();
}
async function seedTopic(id = 't1', deleted = false) {
  await env.DB.prepare(
    `INSERT INTO topics (id, category_slug, author_id, source, title, slug, deleted, last_post_at, created_at)
     VALUES (?, 'general', 'gov-sync', 'user', 'T', ?, ?, ?, ?)`,
  ).bind(id, `s-${id}`, deleted ? 1 : 0, MS, MS).run();
}
async function seedPost(id: string, authorId: string, createdAtMs: number, o: { deleted?: boolean; hidden?: boolean; topicId?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, deleted, hidden, created_at)
     VALUES (?, ?, ?, 'b', '<p>b</p>', ?, ?, ?)`,
  ).bind(id, o.topicId ?? 't1', authorId, o.deleted ? 1 : 0, o.hidden ? 1 : 0, createdAtMs).run();
}
async function lastSeen(id: string) {
  return (await env.DB.prepare('SELECT last_seen AS v FROM users WHERE id = ?').bind(id).first<{ v: number | null }>())?.v ?? null;
}

describe('LAST_SEEN_BACKFILL_SQL', () => {
  beforeEach(async () => { await env.DB.exec('DELETE FROM posts'); await env.DB.exec('DELETE FROM topics'); await env.DB.exec('DELETE FROM users'); });

  // D1's exec() splits input by newline and requires one full statement per
  // line, which breaks this multi-line UPDATE. prepare().run() has no such
  // restriction and runs the exact same statement.
  it('seeds from last_verified_at converted seconds->ms', async () => {
    await seedUser('u1', SEC);
    await env.DB.prepare(LAST_SEEN_BACKFILL_SQL).run();
    expect(await lastSeen('u1')).toBe(MS);
  });

  it('takes the max of verified time and newest qualifying post', async () => {
    await seedTopic();
    await seedUser('u2', SEC);
    await seedPost('p1', 'u2', MS + 5000); // newer than verified time
    await env.DB.prepare(LAST_SEEN_BACKFILL_SQL).run();
    expect(await lastSeen('u2')).toBe(MS + 5000);
  });

  it('ignores deleted/hidden posts and posts in deleted topics', async () => {
    await seedTopic('t1'); await seedTopic('tDel', true);
    await seedUser('u3', SEC);
    await seedPost('d1', 'u3', MS + 9000, { deleted: true });
    await seedPost('h1', 'u3', MS + 9000, { hidden: true });
    await seedPost('x1', 'u3', MS + 9000, { topicId: 'tDel' });
    await env.DB.prepare(LAST_SEEN_BACKFILL_SQL).run();
    expect(await lastSeen('u3')).toBe(MS); // falls back to verified time
  });

  it('leaves a zero-sentinel user without qualifying posts at NULL', async () => {
    await seedUser('u0', 0); // 0 = sentinel, not real activity
    await env.DB.prepare(LAST_SEEN_BACKFILL_SQL).run();
    expect(await lastSeen('u0')).toBeNull();
  });

  it('includes a zero-sentinel user via a qualifying post, seeding last_seen from the post', async () => {
    await seedTopic();
    await seedUser('uP', 0);                 // 0 sentinel: excluded by the > 0 guard on its own
    await seedPost('pp', 'uP', MS + 7000);   // qualifying post pulls the row in via EXISTS
    await env.DB.prepare(LAST_SEEN_BACKFILL_SQL).run();
    expect(await lastSeen('uP')).toBe(MS + 7000);
  });

  it('never seeds reserved accounts', async () => {
    await seedUser('system', SEC);
    await seedUser('gov-sync', SEC);
    await env.DB.prepare(LAST_SEEN_BACKFILL_SQL).run();
    expect(await lastSeen('system')).toBeNull();
    expect(await lastSeen('gov-sync')).toBeNull();
  });
});

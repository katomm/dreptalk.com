import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
// The migration is pure SQL; run its exact text so the test tracks the shipped
// statement rather than a copy.
import backfillSql from '../../../migrations/0058_backfill_vote_rationale_activity.sql?raw';

// The shipped file is one INSERT wrapped in -- comments; the real migration
// runner strips those, so do the same before handing it to prepare().
const runBackfill = () =>
  env.DB.prepare(
    backfillSql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
      .trim(),
  ).run();

async function seedPost(
  id: string,
  topicId: string,
  opts: { source?: string; deleted?: number; topicDeleted?: number } = {},
) {
  await env.DB.prepare(`INSERT OR IGNORE INTO topics (id, category_slug, author_id, source, title, slug, deleted, last_post_at, created_at) VALUES (?, 'general', 'sys', 'governance', ?, ?, ?, 1500, 1000)`)
    .bind(topicId, `T ${topicId}`, topicId, opts.topicDeleted ?? 0)
    .run();
  await env.DB.prepare(`INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at, source, deleted) VALUES (?, ?, ?, 'x', '<p>x</p>', 1500, ?, ?)`)
    .bind(id, topicId, `author-${id}`, opts.source ?? 'vote_rationale', opts.deleted ?? 0)
    .run();
}

async function eventCount(refPostId: string) {
  return (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM activity WHERE type = 'reply_created' AND ref_post_id = ?`)
      .bind(refPostId)
      .first<{ n: number }>()
  )?.n;
}

describe('0058 backfill vote_rationale activity', () => {
  it('backfills a live cross-post, skips deleted posts and deleted topics, and is idempotent', async () => {
    await seedPost('bf-live', 'bf-topic-live');
    await seedPost('bf-optedout', 'bf-topic-live', { deleted: 1 });
    await seedPost('bf-in-deleted-topic', 'bf-topic-gone', { topicDeleted: 1 });
    await seedPost('bf-normal-reply', 'bf-topic-live', { source: 'user' });

    await runBackfill();

    expect(await eventCount('bf-live')).toBe(1);
    expect(await eventCount('bf-optedout')).toBe(0);
    expect(await eventCount('bf-in-deleted-topic')).toBe(0);
    // A normal post is not the migration's concern (0030 already covered those).
    expect(await eventCount('bf-normal-reply')).toBe(0);

    // Re-running must not duplicate the event.
    await runBackfill();
    expect(await eventCount('bf-live')).toBe(1);
  });

  it('leaves an already-emitted event untouched', async () => {
    await seedPost('bf-has-event', 'bf-topic-existing');
    await env.DB.prepare(`INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at) VALUES ('runtime-uuid', 'reply_created', 'author-bf-has-event', 'bf-topic-existing', 'bf-has-event', NULL, 1500)`).run();

    await runBackfill();

    expect(await eventCount('bf-has-event')).toBe(1);
  });
});

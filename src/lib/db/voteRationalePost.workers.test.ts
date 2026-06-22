import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertVoteRationalePost } from './voteRationalePost.js';

// No FK constraints in D1 test env, so we can insert posts without seeding
// a topic or user row first.

describe('upsertVoteRationalePost', () => {
  it('creates one vote_rationale post then updates it on re-vote', async () => {
    const topicId = 'test-topic-vrp-1';
    const authorId = 'user-vrp-1';

    await upsertVoteRationalePost(env.DB, {
      topicId,
      authorId,
      vote: 'yes',
      bodyMd: 'First reason',
      bodyHtml: '<p>First reason</p>',
      now: 1000,
    });

    // Verify body_html is stored on create
    const afterCreate = (await env.DB.prepare(
      `SELECT body_md, body_html, vote, source FROM posts WHERE topic_id = ? AND author_id = ? AND source = 'vote_rationale'`,
    ).bind(topicId, authorId).all()).results;
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0].vote).toBe('yes');
    expect(afterCreate[0].body_md).toBe('First reason');
    expect(afterCreate[0].body_html).toBe('<p>First reason</p>');

    await upsertVoteRationalePost(env.DB, {
      topicId,
      authorId,
      vote: 'no',
      bodyMd: 'Changed my mind',
      bodyHtml: '<p>Changed my mind</p>',
      now: 2000,
    });

    // Verify updated in place with new body_html, not duplicated
    const afterUpdate = (await env.DB.prepare(
      `SELECT body_md, body_html, vote, source FROM posts WHERE topic_id = ? AND author_id = ? AND source = 'vote_rationale'`,
    ).bind(topicId, authorId).all()).results;
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0].vote).toBe('no');
    expect(afterUpdate[0].body_md).toBe('Changed my mind');
    expect(afterUpdate[0].body_html).toBe('<p>Changed my mind</p>');
  });
});

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertVoteRationalePost } from './voteRationalePost.js';

// No FK constraints in D1 test env, so we can insert posts without seeding
// a topic or user row first.

describe('upsertVoteRationalePost', () => {
  it('creates one vote_rationale post then updates it on re-vote', async () => {
    const topicId = 'test-topic-vrp-1';
    const authorId = 'user-vrp-1';
    const gaId = `${'c'.repeat(64)}#0`;

    await upsertVoteRationalePost(env.DB, { topicId, authorId, gaId, vote: 'yes', bodyMd: 'First reason', now: 1000 });
    await upsertVoteRationalePost(env.DB, { topicId, authorId, gaId, vote: 'no', bodyMd: 'Changed my mind', now: 2000 });

    const rows = (await env.DB.prepare(
      `SELECT body_md, vote, source FROM posts WHERE topic_id = ? AND author_id = ? AND source = 'vote_rationale'`,
    ).bind(topicId, authorId).all()).results;
    expect(rows).toHaveLength(1); // updated in place, not duplicated
    expect(rows[0].vote).toBe('no');
    expect(rows[0].body_md).toBe('Changed my mind');
  });
});

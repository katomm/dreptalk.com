import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertVoteRationalePost, removeVoteRationalePost } from './voteRationalePost.js';

// Reads the reply_created activity events emitted for a given cross-post author,
// scoped to one topic, so the assertions below stay independent across tests.
async function rationaleEvents(topicId: string, authorId: string) {
  return (
    await env.DB.prepare(
      `SELECT a.id, a.ref_post_id, a.actor_id, a.type
       FROM activity a JOIN posts p ON p.id = a.ref_post_id
       WHERE p.topic_id = ? AND p.author_id = ? AND p.source = 'vote_rationale'`,
    )
      .bind(topicId, authorId)
      .all()
  ).results;
}

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

  it('emits one reply_created activity event on create and none extra on in-place re-vote', async () => {
    const topicId = 'test-topic-vrp-act-1';
    const authorId = 'user-vrp-act-1';

    await upsertVoteRationalePost(env.DB, {
      topicId, authorId, vote: 'yes',
      bodyMd: 'Reason', bodyHtml: '<p>Reason</p>', now: 1000,
    });

    const postId = (await env.DB.prepare(
      `SELECT id FROM posts WHERE topic_id = ? AND author_id = ? AND source = 'vote_rationale'`,
    ).bind(topicId, authorId).first<{ id: string }>())?.id;

    const afterCreate = await rationaleEvents(topicId, authorId);
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0].type).toBe('reply_created');
    expect(afterCreate[0].ref_post_id).toBe(postId);
    expect(afterCreate[0].actor_id).toBe(authorId);

    // A live re-vote edits the post in place and must NOT add a second event.
    await upsertVoteRationalePost(env.DB, {
      topicId, authorId, vote: 'no',
      bodyMd: 'Changed', bodyHtml: '<p>Changed</p>', now: 2000,
    });
    expect(await rationaleEvents(topicId, authorId)).toHaveLength(1);
  });

  it('removes the activity event on opt-out and re-adds one on revive', async () => {
    const topicId = 'test-topic-vrp-act-2';
    const authorId = 'user-vrp-act-2';

    await upsertVoteRationalePost(env.DB, {
      topicId, authorId, vote: 'yes',
      bodyMd: 'Reason', bodyHtml: '<p>Reason</p>', now: 1000,
    });
    expect(await rationaleEvents(topicId, authorId)).toHaveLength(1);

    // Opt-out on a re-vote withdraws the cross-post; its feed event goes too.
    await removeVoteRationalePost(env.DB, { topicId, authorId });
    expect(await rationaleEvents(topicId, authorId)).toHaveLength(0);

    // Re-voting with the box ticked again revives the post and re-surfaces it.
    await upsertVoteRationalePost(env.DB, {
      topicId, authorId, vote: 'yes',
      bodyMd: 'Reason again', bodyHtml: '<p>Reason again</p>', now: 3000,
    });
    expect(await rationaleEvents(topicId, authorId)).toHaveLength(1);
  });
});

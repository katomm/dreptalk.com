import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost } from './forum.js';
import { getTopicParticipants } from './discussions.js';

const db = () => env.DB;

describe('getTopicParticipants', () => {
  it('returns authors ranked by live post count', async () => {
    const cat = 'general';
    const { topic } = await createTopic(db(), {
      categorySlug: cat, authorId: 'alice', title: 'Participants topic',
      bodyMd: 'op', bodyHtml: '<p>op</p>', now: 1_700_000_000_000, rand: 'p001',
    });
    await createPost(db(), { topicId: topic.id, authorId: 'bob', bodyMd: 'r1', bodyHtml: '<p>r1</p>', now: 1_700_000_100_000, rand: 'p002' });
    await createPost(db(), { topicId: topic.id, authorId: 'bob', bodyMd: 'r2', bodyHtml: '<p>r2</p>', now: 1_700_000_200_000, rand: 'p003' });

    const result = await getTopicParticipants(db(), topic.id);

    expect(result).toEqual([
      { authorId: 'bob', posts: 2 },
      { authorId: 'alice', posts: 1 },
    ]);
  });
});

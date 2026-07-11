import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost } from './forum.js';
import { getTopicParticipants, getParticipantCounts } from './discussions.js';

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

describe('getParticipantCounts', () => {
  it('counts distinct authors per topic', async () => {
    const { topic: a } = await createTopic(db(), {
      categorySlug: 'general', authorId: 'alice', title: 'Counts A',
      bodyMd: 'op', bodyHtml: '<p>op</p>', now: 1_700_010_000_000, rand: 'c001',
    });
    await createPost(db(), { topicId: a.id, authorId: 'bob', bodyMd: 'r', bodyHtml: '<p>r</p>', now: 1_700_010_100_000, rand: 'c002' });
    await createPost(db(), { topicId: a.id, authorId: 'alice', bodyMd: 'r', bodyHtml: '<p>r</p>', now: 1_700_010_200_000, rand: 'c003' });
    const { topic: b } = await createTopic(db(), {
      categorySlug: 'general', authorId: 'carol', title: 'Counts B',
      bodyMd: 'op', bodyHtml: '<p>op</p>', now: 1_700_010_300_000, rand: 'c004',
    });

    const counts = await getParticipantCounts(db(), [a.id, b.id, 'missing']);

    expect(counts.get(a.id)).toBe(2);
    expect(counts.get(b.id)).toBe(1);
    expect(counts.has('missing')).toBe(false);
  });

  it('returns an empty map for no ids', async () => {
    const counts = await getParticipantCounts(db(), []);
    expect(counts.size).toBe(0);
  });
});

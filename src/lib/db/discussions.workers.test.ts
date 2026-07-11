import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost } from './forum.js';
import {
  getTopicParticipants,
  getParticipantCounts,
  getRelatedTopics,
  getTopicExcerpts,
  getDiscussionTopics,
  parseDiscussionSort,
} from './discussions.js';

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

describe('getTopicExcerpts', () => {
  it('returns the opening post body per topic', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general', authorId: 'alice', title: 'Excerpt topic',
      bodyMd: 'the opening body', bodyHtml: '<p>the opening body</p>', now: 1_700_030_000_000, rand: 'ex01',
    });
    await createPost(db(), { topicId: topic.id, authorId: 'bob', bodyMd: 'a reply', bodyHtml: '<p>a reply</p>', now: 1_700_030_100_000, rand: 'ex02' });

    const map = await getTopicExcerpts(db(), [topic.id]);

    expect(map.get(topic.id)).toBe('<p>the opening body</p>');
  });
});

describe('getRelatedTopics', () => {
  it('returns same-category topics, newest first, excluding the current one', async () => {
    const mk = (title: string, now: number, rand: string) =>
      createTopic(db(), { categorySlug: 'constitution', authorId: 'alice', title, bodyMd: 'op', bodyHtml: '<p>op</p>', now, rand });
    const { topic: current } = await mk('Current', 1_700_020_000_000, 'rel0');
    const { topic: older } = await mk('Older', 1_700_020_100_000, 'rel1');
    const { topic: newer } = await mk('Newer', 1_700_020_200_000, 'rel2');
    // A topic in a different category must be excluded.
    const { topic: otherCat } = await createTopic(db(), { categorySlug: 'general', authorId: 'alice', title: 'Other cat', bodyMd: 'op', bodyHtml: '<p>op</p>', now: 1_700_020_400_000, rand: 'rel4' });

    const related = await getRelatedTopics(db(), 'constitution', current.id, { limit: 5 });

    const ids = related.map((t) => t.id);
    expect(ids).not.toContain(current.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect(ids).not.toContain(otherCat.id);
    expect(related.every((t) => t.category_slug === 'constitution')).toBe(true);
  });
});

describe('parseDiscussionSort', () => {
  it('defaults unknown to latest', () => {
    expect(parseDiscussionSort('bogus')).toBe('latest');
    expect(parseDiscussionSort('unanswered')).toBe('unanswered');
  });
});

describe('getDiscussionTopics', () => {
  const CAT = 'budget';
  it('unanswered returns only topics with a single post', async () => {
    const { topic: lonely } = await createTopic(db(), {
      categorySlug: CAT, authorId: 'alice', title: 'Lonely',
      bodyMd: 'op', bodyHtml: '<p>op</p>', now: 1_700_040_000_000, rand: 'ds01',
    });
    const { topic: answered } = await createTopic(db(), {
      categorySlug: CAT, authorId: 'alice', title: 'Answered',
      bodyMd: 'op', bodyHtml: '<p>op</p>', now: 1_700_040_100_000, rand: 'ds02',
    });
    await createPost(db(), { topicId: answered.id, authorId: 'bob', bodyMd: 'r', bodyHtml: '<p>r</p>', now: 1_700_040_200_000, rand: 'ds03' });

    const rows = await getDiscussionTopics(db(), CAT, { sort: 'unanswered' });
    const ids = rows.map((t) => t.id);
    expect(ids).toContain(lonely.id);
    expect(ids).not.toContain(answered.id);
  });

  it('newest orders by created_at desc', async () => {
    const { topic: first } = await createTopic(db(), { categorySlug: CAT, authorId: 'alice', title: 'First', bodyMd: 'op', bodyHtml: '<p>op</p>', now: 1_700_041_000_000, rand: 'ds10' });
    const { topic: second } = await createTopic(db(), { categorySlug: CAT, authorId: 'alice', title: 'Second', bodyMd: 'op', bodyHtml: '<p>op</p>', now: 1_700_041_100_000, rand: 'ds11' });
    const rows = await getDiscussionTopics(db(), CAT, { sort: 'newest' });
    const ids = rows.map((t) => t.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it('trending ranks topics with recent replies first', async () => {
    const now = 1_700_050_000_000;
    const { topic: hot } = await createTopic(db(), { categorySlug: CAT, authorId: 'alice', title: 'Hot', bodyMd: 'op', bodyHtml: '<p>op</p>', now: now - 3_000_000, rand: 'ds20' });
    const { topic: cold } = await createTopic(db(), { categorySlug: CAT, authorId: 'alice', title: 'Cold', bodyMd: 'op', bodyHtml: '<p>op</p>', now: now - 2_000_000, rand: 'ds21' });
    // A recent reply on hot (createPost writes a reply_created activity row at `now`).
    await createPost(db(), { topicId: hot.id, authorId: 'bob', bodyMd: 'r', bodyHtml: '<p>r</p>', now: now - 1_000_000, rand: 'ds22' });

    const rows = await getDiscussionTopics(db(), CAT, { sort: 'trending', nowMs: now });
    const ids = rows.map((t) => t.id);
    expect(ids.indexOf(hot.id)).toBeLessThan(ids.indexOf(cold.id));
  });
});

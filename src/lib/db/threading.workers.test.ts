/// <reference types="@cloudflare/workers-types" />
// One-level threading tests -- run in real workerd via @cloudflare/vitest-pool-workers.
// Covers createPost's parent validation and level lifting, getThreadPage's
// grouping and top-level pagination, and the getTopicStats aggregate.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost, getThreadPage } from './forum.js';

const db = () => env.DB;
const NOW = 1_753_000_000_000;

let seq = 0;
async function newTopic(): Promise<{ topicId: string; openerId: string }> {
  seq++;
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general',
    authorId: `author-${seq}`,
    title: `Threading fixture ${seq}`,
    bodyMd: 'opener',
    bodyHtml: '<p>opener</p>',
    now: NOW,
    rand: `th${seq}`,
  });
  return { topicId: topic.id, openerId: firstPost.id };
}

function reply(topicId: string, authorId: string, parentPostId: string | null, at: number) {
  return createPost(db(), {
    topicId,
    authorId,
    bodyMd: 'body',
    bodyHtml: '<p>body</p>',
    now: at,
    parentPostId,
  });
}

describe('createPost: one-level threading', () => {
  it('stores the parent for a reply to a top-level post', async () => {
    const { topicId } = await newTopic();
    const top = await reply(topicId, 'a', null, NOW + 1000);
    const child = await reply(topicId, 'b', top.id, NOW + 2000);
    expect(child.parent_post_id).toBe(top.id);
  });

  it('lifts a reply to a reply onto the top-level parent', async () => {
    const { topicId } = await newTopic();
    const top = await reply(topicId, 'a', null, NOW + 1000);
    const child = await reply(topicId, 'b', top.id, NOW + 2000);
    const grandchild = await reply(topicId, 'c', child.id, NOW + 3000);
    expect(grandchild.parent_post_id).toBe(top.id);
  });

  it('rejects a parent from another topic', async () => {
    const { topicId } = await newTopic();
    const other = await newTopic();
    const foreign = await reply(other.topicId, 'a', null, NOW + 1000);
    await expect(reply(topicId, 'b', foreign.id, NOW + 2000)).rejects.toThrow('parent_not_found');
  });

  it('rejects a missing parent', async () => {
    const { topicId } = await newTopic();
    await expect(reply(topicId, 'a', crypto.randomUUID(), NOW + 1000)).rejects.toThrow(
      'parent_not_found',
    );
  });
});

describe('getThreadPage', () => {
  it('groups replies under their parent, both ordered oldest first', async () => {
    const { topicId, openerId } = await newTopic();
    const top1 = await reply(topicId, 'a', null, NOW + 1000);
    const top2 = await reply(topicId, 'b', null, NOW + 2000);
    const r2 = await reply(topicId, 'c', top1.id, NOW + 4000);
    const r1 = await reply(topicId, 'd', top1.id, NOW + 3000);

    const pageData = await getThreadPage(db(), topicId);
    expect(pageData.topLevel.map((p) => p.id)).toEqual([openerId, top1.id, top2.id]);
    expect(pageData.childrenByParent.get(top1.id)?.map((p) => p.id)).toEqual([r1.id, r2.id]);
    expect(pageData.childrenByParent.has(top2.id)).toBe(false);
  });

  it('paginates by top-level posts and keeps replies with their parent', async () => {
    const { topicId, openerId } = await newTopic();
    const top1 = await reply(topicId, 'a', null, NOW + 1000);
    const top2 = await reply(topicId, 'b', null, NOW + 2000);
    // The reply is newer than everything, but belongs to page 1's parent.
    const child = await reply(topicId, 'c', top1.id, NOW + 9000);

    const page1 = await getThreadPage(db(), topicId, { limit: 2, offset: 0 });
    expect(page1.topLevel.map((p) => p.id)).toEqual([openerId, top1.id]);
    expect(page1.childrenByParent.get(top1.id)?.map((p) => p.id)).toEqual([child.id]);
    // Page 1 contains the opener; deeper pages do not.
    expect(page1.openingPost?.id).toBe(openerId);

    const page2 = await getThreadPage(db(), topicId, { limit: 2, offset: 2 });
    expect(page2.topLevel.map((p) => p.id)).toEqual([top2.id]);
    expect(page2.childrenByParent.size).toBe(0);
    expect(page2.openingPost).toBeNull();
  });
});

describe('getThreadPage stats', () => {
  it('counts distinct participants', async () => {
    const { topicId } = await newTopic();
    await reply(topicId, 'second-author', null, NOW + 1000);
    await reply(topicId, 'second-author', null, NOW + 2000);

    const { stats } = await getThreadPage(db(), topicId);
    expect(stats).toEqual({ participants: 2 });
  });

  it('returns null stats for an unknown topic', async () => {
    const { stats } = await getThreadPage(db(), crypto.randomUUID());
    expect(stats).toBeNull();
  });
});

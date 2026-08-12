// Forum D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises all forum.ts functions against the real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getThreadPage,
  slugify,
  createTopic,
  getTopicBySlug,
  getTopicsByCategory,
  getTopicsByIds,
  createPost,
  getPostsByAuthor,
  buildTopicPostedAtStatements,
  setGovTopicTitleAndBody,
} from './forum.js';
import { upsertVoteRationalePost } from './voteRationalePost.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';

const db = () => env.DB;

// Deterministic timestamps: use distinct values to avoid cross-test collisions.
const T1 = 1_700_000_000;
const T2 = 1_700_001_000;
const T3 = 1_700_002_000;

// Unique author id for all tests.
const AUTHOR = 'test-author-forum';

// ---- slugify ----------------------------------------------------------------

describe('slugify', () => {
  it('converts spaces and punctuation to hyphens', () => {
    expect(slugify('Hello World!', 'abc')).toBe('hello-world-abc');
  });

  it('lowercases the title', () => {
    expect(slugify('UPPERCASE Title', 'x1')).toBe('uppercase-title-x1');
  });

  it('strips leading and trailing hyphens from the base', () => {
    expect(slugify('  leading trailing  ', 'zz')).toBe('leading-trailing-zz');
  });

  it('appends the supplied suffix after a hyphen', () => {
    const result = slugify('My Post', 'r4nd');
    expect(result.endsWith('-r4nd')).toBe(true);
  });

  it('collapses consecutive non-alphanumeric runs into one hyphen', () => {
    expect(slugify('foo---bar!!!baz', 'q1')).toBe('foo-bar-baz-q1');
  });

  it('caps base at 60 characters before appending suffix', () => {
    const long = 'a'.repeat(80);
    const result = slugify(long, 'sfx');
    // base part is at most 60 chars, then '-sfx'
    const base = result.slice(0, result.lastIndexOf('-sfx'));
    expect(base.length).toBeLessThanOrEqual(60);
    expect(result.endsWith('-sfx')).toBe(true);
  });

  it('produces consistent output for the same inputs', () => {
    expect(slugify('Cardano DRep Forum', 'fixed')).toBe(
      slugify('Cardano DRep Forum', 'fixed'),
    );
  });
});

// ---- createTopic ------------------------------------------------------------

describe('createTopic', () => {
  it('inserts a topic and its first post', async () => {
    const { topic, firstPost } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'My First Topic',
      bodyMd: '# Hello',
      bodyHtml: '<h1>Hello</h1>',
      now: T1,
      rand: 'r001',
    });

    expect(topic.id).toBeTruthy();
    expect(topic.category_slug).toBe('general');
    expect(topic.author_id).toBe(AUTHOR);
    expect(topic.title).toBe('My First Topic');
    expect(topic.slug).toBe('my-first-topic-r001');
    expect(topic.post_count).toBe(1);
    expect(topic.last_post_at).toBe(T1);
    expect(topic.created_at).toBe(T1);

    expect(firstPost.id).toBeTruthy();
    expect(firstPost.topic_id).toBe(topic.id);
    expect(firstPost.author_id).toBe(AUTHOR);
    expect(firstPost.body_md).toBe('# Hello');
    expect(firstPost.body_html).toBe('<h1>Hello</h1>');
    expect(firstPost.created_at).toBe(T1);
  });

  it('defaults source to "user"', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Source Default Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      rand: 'r002',
    });
    expect(topic.source).toBe('user');
  });

  it('accepts source "governance"', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'governance',
      authorId: AUTHOR,
      title: 'Governance Topic',
      bodyMd: 'gov body',
      bodyHtml: '<p>gov body</p>',
      source: 'governance',
      now: T1,
      rand: 'r003',
    });
    expect(topic.source).toBe('governance');
  });

  it('stores body_html in the first post', async () => {
    const { firstPost } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Html Storage Topic',
      bodyMd: '**bold**',
      bodyHtml: '<p><strong>bold</strong></p>',
      now: T1,
      rand: 'r004',
    });
    expect(firstPost.body_html).toBe('<p><strong>bold</strong></p>');
  });

  it('maps pinned/locked/deleted as JS booleans', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Boolean Mapping Topic',
      bodyMd: 'content',
      bodyHtml: '<p>content</p>',
      now: T1,
      rand: 'r005',
    });
    expect(typeof topic.pinned).toBe('boolean');
    expect(typeof topic.locked).toBe('boolean');
    expect(typeof topic.deleted).toBe('boolean');
    expect(topic.pinned).toBe(false);
    expect(topic.locked).toBe(false);
    expect(topic.deleted).toBe(false);
  });

  it('uses postedAt for the topic and first-post timestamps when provided', async () => {
    const POSTED = 1_650_000_000_000; // distinct from the `now` below
    const { topic, firstPost } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Backdated Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      postedAt: POSTED,
      rand: 'rpd1',
    });
    expect(topic.created_at).toBe(POSTED);
    expect(topic.last_post_at).toBe(POSTED);
    expect(firstPost.created_at).toBe(POSTED);

    // Persisted, not just the returned object.
    const stored = await db()
      .prepare('SELECT created_at, last_post_at FROM topics WHERE id = ?')
      .bind(topic.id)
      .first<{ created_at: number; last_post_at: number }>();
    expect(stored).toEqual({ created_at: POSTED, last_post_at: POSTED });
  });

  it('persists proposer_grant_id on the topic and first post when given, null otherwise', async () => {
    const { topic: withGrant, firstPost: firstPostWithGrant } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Mandate Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      rand: 'grnt1',
      proposerGrantId: 'grant-abc',
    });
    expect(withGrant.proposer_grant_id).toBe('grant-abc');
    expect(firstPostWithGrant.proposer_grant_id).toBe('grant-abc');
    const storedTopic = await db()
      .prepare('SELECT proposer_grant_id FROM topics WHERE id = ?')
      .bind(withGrant.id)
      .first<{ proposer_grant_id: string | null }>();
    expect(storedTopic?.proposer_grant_id).toBe('grant-abc');
    const storedPost = await db()
      .prepare('SELECT proposer_grant_id FROM posts WHERE id = ?')
      .bind(firstPostWithGrant.id)
      .first<{ proposer_grant_id: string | null }>();
    expect(storedPost?.proposer_grant_id).toBe('grant-abc');

    const { topic: withoutGrant, firstPost: firstPostWithoutGrant } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Personal Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      rand: 'grnt2',
    });
    expect(withoutGrant.proposer_grant_id).toBeNull();
    expect(firstPostWithoutGrant.proposer_grant_id).toBeNull();
  });
});

// ---- getTopicBySlug ---------------------------------------------------------

describe('getTopicBySlug', () => {
  it('returns the topic for a known slug', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Findable Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      rand: 'r010',
    });

    const found = await getTopicBySlug(db(), topic.slug);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(topic.id);
    expect(found!.title).toBe('Findable Topic');
  });

  it('returns null for an unknown slug', async () => {
    const result = await getTopicBySlug(db(), 'definitely-does-not-exist-xyz');
    expect(result).toBeNull();
  });
});

// ---- getTopicsByCategory ----------------------------------------------------

describe('getTopicsByCategory', () => {
  it('returns only topics in the matching category', async () => {
    const catSlug = 'cat-filter-test';
    const { topic } = await createTopic(db(), {
      categorySlug: catSlug,
      authorId: AUTHOR,
      title: 'Category Specific Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      rand: 'r020',
    });

    // A topic in a different category should not appear.
    await createTopic(db(), {
      categorySlug: 'other-cat',
      authorId: AUTHOR,
      title: 'Other Category Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      rand: 'r021',
    });

    const results = await getTopicsByCategory(db(), catSlug);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every(t => t.category_slug === catSlug)).toBe(true);
    expect(results.some(t => t.id === topic.id)).toBe(true);
  });

  it('excludes deleted topics', async () => {
    const catSlug = 'cat-deleted-test';
    const { topic } = await createTopic(db(), {
      categorySlug: catSlug,
      authorId: AUTHOR,
      title: 'Deleted Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      rand: 'r022',
    });

    // Soft-delete the topic directly.
    await db()
      .prepare('UPDATE topics SET deleted = 1 WHERE id = ?')
      .bind(topic.id)
      .run();

    const results = await getTopicsByCategory(db(), catSlug);
    expect(results.some(t => t.id === topic.id)).toBe(false);
  });

  it('orders pinned topics first, then by last_post_at desc', async () => {
    const catSlug = 'cat-order-test';
    const t1Now = T1;
    const t2Now = T2;

    const { topic: unpinnedOlder } = await createTopic(db(), {
      categorySlug: catSlug,
      authorId: AUTHOR,
      title: 'Unpinned Older Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: t1Now,
      rand: 'r030',
    });

    const { topic: unpinnedNewer } = await createTopic(db(), {
      categorySlug: catSlug,
      authorId: AUTHOR,
      title: 'Unpinned Newer Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: t2Now,
      rand: 'r031',
    });

    const { topic: pinnedOlder } = await createTopic(db(), {
      categorySlug: catSlug,
      authorId: AUTHOR,
      title: 'Pinned Older Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: t1Now,
      rand: 'r032',
    });

    // Pin the third topic.
    await db()
      .prepare('UPDATE topics SET pinned = 1 WHERE id = ?')
      .bind(pinnedOlder.id)
      .run();

    const results = await getTopicsByCategory(db(), catSlug);

    const ids = results.map(t => t.id);
    const pinnedIdx = ids.indexOf(pinnedOlder.id);
    const newerIdx = ids.indexOf(unpinnedNewer.id);
    const olderIdx = ids.indexOf(unpinnedOlder.id);

    // Pinned must come before unpinned topics.
    expect(pinnedIdx).toBeLessThan(newerIdx);
    expect(pinnedIdx).toBeLessThan(olderIdx);
    // Among unpinned: newer last_post_at first.
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('respects limit and offset', async () => {
    const catSlug = 'cat-pagination-test';
    // Insert 3 topics.
    for (let i = 0; i < 3; i++) {
      await createTopic(db(), {
        categorySlug: catSlug,
        authorId: AUTHOR,
        title: `Pagination Topic ${i}`,
        bodyMd: 'body',
        bodyHtml: '<p>body</p>',
        now: T1 + i,
        rand: `r04${i}`,
      });
    }

    const page1 = await getTopicsByCategory(db(), catSlug, { limit: 2 });
    expect(page1.length).toBe(2);

    const page2 = await getTopicsByCategory(db(), catSlug, { limit: 2, offset: 2 });
    expect(page2.length).toBe(1);

    // Ensure no overlap between pages.
    const allIds = [...page1.map(t => t.id), ...page2.map(t => t.id)];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('caps limit at 100', async () => {
    const catSlug = 'cat-cap-test';
    await createTopic(db(), {
      categorySlug: catSlug,
      authorId: AUTHOR,
      title: 'Cap Test Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      rand: 'r050',
    });

    // Requesting 200 should be silently capped; we can only verify it does not throw
    // and returns at most 100 rows (we have 1 here).
    const results = await getTopicsByCategory(db(), catSlug, { limit: 200 });
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it('clamps negative limit: limit -1 does not bypass the row cap', async () => {
    const catSlug = 'cat-neg-limit-test';
    // Insert 3 topics into the category.
    for (let i = 0; i < 3; i++) {
      await createTopic(db(), {
        categorySlug: catSlug,
        authorId: AUTHOR,
        title: `Neg Limit Topic ${i}`,
        bodyMd: 'body',
        bodyHtml: '<p>body</p>',
        now: T1 + i,
        rand: `r05n${i}`,
      });
    }

    // limit: -1 must be clamped to 1, not passed as LIMIT -1 to SQLite.
    const negResult = await getTopicsByCategory(db(), catSlug, { limit: -1 });
    expect(negResult.length).toBeGreaterThanOrEqual(1);
    expect(negResult.length).toBeLessThanOrEqual(100);

    // Explicitly: must not return more rows than the clamped-up value of 1.
    expect(negResult.length).toBe(1);
  });

  it('clamps limit 1000 to at most 100', async () => {
    const catSlug = 'cat-1000-limit-test';
    for (let i = 0; i < 3; i++) {
      await createTopic(db(), {
        categorySlug: catSlug,
        authorId: AUTHOR,
        title: `Limit 1000 Topic ${i}`,
        bodyMd: 'body',
        bodyHtml: '<p>body</p>',
        now: T1 + i,
        rand: `r05k${i}`,
      });
    }

    const results = await getTopicsByCategory(db(), catSlug, { limit: 1000 });
    expect(results.length).toBeLessThanOrEqual(100);
  });
});

// ---- createPost + thread reads -----------------------------------------------

// All posts in these tests are top-level, so the thread page's topLevel list is
// exactly what the flat post list used to be.
async function topLevelPosts(topicId: string, opts?: { limit?: number; offset?: number }) {
  return (await getThreadPage(env.DB, topicId, opts)).topLevel;
}

describe('createPost', () => {
  it('increments post_count and updates last_post_at on the topic', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Post Count Topic',
      bodyMd: 'original',
      bodyHtml: '<p>original</p>',
      now: T1,
      rand: 'r060',
    });

    expect(topic.post_count).toBe(1);

    await createPost(db(), {
      topicId: topic.id,
      authorId: AUTHOR,
      bodyMd: 'reply',
      bodyHtml: '<p>reply</p>',
      now: T2,
    });

    const updated = await getTopicBySlug(db(), topic.slug);
    expect(updated!.post_count).toBe(2);
    expect(updated!.last_post_at).toBe(T2);
  });

  it('returns the created post with correct fields', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Return Post Topic',
      bodyMd: 'original',
      bodyHtml: '<p>original</p>',
      now: T1,
      rand: 'r061',
    });

    const post = await createPost(db(), {
      topicId: topic.id,
      authorId: AUTHOR,
      bodyMd: '**reply**',
      bodyHtml: '<p><strong>reply</strong></p>',
      now: T2,
    });

    expect(post.id).toBeTruthy();
    expect(post.topic_id).toBe(topic.id);
    expect(post.author_id).toBe(AUTHOR);
    expect(post.body_md).toBe('**reply**');
    expect(post.body_html).toBe('<p><strong>reply</strong></p>');
    expect(post.created_at).toBe(T2);
    expect(typeof post.deleted).toBe('boolean');
    expect(post.deleted).toBe(false);
  });

  it('persists proposer_grant_id when given, null otherwise', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Reply Grant Topic',
      bodyMd: 'original',
      bodyHtml: '<p>original</p>',
      now: T1,
      rand: 'r063',
    });

    const withGrant = await createPost(db(), {
      topicId: topic.id,
      authorId: AUTHOR,
      bodyMd: 'mandate reply',
      bodyHtml: '<p>mandate reply</p>',
      now: T2,
      proposerGrantId: 'grant-xyz',
    });
    expect(withGrant.proposer_grant_id).toBe('grant-xyz');
    const stored = await db()
      .prepare('SELECT proposer_grant_id FROM posts WHERE id = ?')
      .bind(withGrant.id)
      .first<{ proposer_grant_id: string | null }>();
    expect(stored?.proposer_grant_id).toBe('grant-xyz');

    const withoutGrant = await createPost(db(), {
      topicId: topic.id,
      authorId: AUTHOR,
      bodyMd: 'personal reply',
      bodyHtml: '<p>personal reply</p>',
      now: T3,
    });
    expect(withoutGrant.proposer_grant_id).toBeNull();
  });

  it('getThreadPage returns top-level posts in created_at asc order', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Ordering Topic',
      bodyMd: 'first',
      bodyHtml: '<p>first</p>',
      now: T1,
      rand: 'r062',
    });

    await createPost(db(), {
      topicId: topic.id,
      authorId: AUTHOR,
      bodyMd: 'second',
      bodyHtml: '<p>second</p>',
      now: T2,
    });

    await createPost(db(), {
      topicId: topic.id,
      authorId: AUTHOR,
      bodyMd: 'third',
      bodyHtml: '<p>third</p>',
      now: T3,
    });

    const posts = await topLevelPosts(topic.id);
    expect(posts.length).toBe(3);

    // Must be sorted ascending by created_at.
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i].created_at).toBeGreaterThanOrEqual(posts[i - 1].created_at);
    }

    // Verify content order via body_html (body_md is not selected by the thread reader).
    expect(posts[0].body_html).toBe('<p>first</p>');
    expect(posts[1].body_html).toBe('<p>second</p>');
    expect(posts[2].body_html).toBe('<p>third</p>');
  });

  it('throws "topic_locked" when posting to a locked topic', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Locked Topic',
      bodyMd: 'original',
      bodyHtml: '<p>original</p>',
      now: T1,
      rand: 'r063',
    });

    await db()
      .prepare('UPDATE topics SET locked = 1 WHERE id = ?')
      .bind(topic.id)
      .run();

    await expect(
      createPost(db(), {
        topicId: topic.id,
        authorId: AUTHOR,
        bodyMd: 'reply',
        bodyHtml: '<p>reply</p>',
        now: T2,
      }),
    ).rejects.toThrow('topic_locked');
  });

  it('throws "topic_not_found" for a missing topic id', async () => {
    await expect(
      createPost(db(), {
        topicId: 'non-existent-topic-id',
        authorId: AUTHOR,
        bodyMd: 'reply',
        bodyHtml: '<p>reply</p>',
        now: T1,
      }),
    ).rejects.toThrow('topic_not_found');
  });

  it('throws "topic_not_found" when posting to a deleted topic', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Deleted Topic for Post',
      bodyMd: 'original',
      bodyHtml: '<p>original</p>',
      now: T1,
      rand: 'r064',
    });

    await db()
      .prepare('UPDATE topics SET deleted = 1 WHERE id = ?')
      .bind(topic.id)
      .run();

    await expect(
      createPost(db(), {
        topicId: topic.id,
        authorId: AUTHOR,
        bodyMd: 'reply',
        bodyHtml: '<p>reply</p>',
        now: T2,
      }),
    ).rejects.toThrow('topic_not_found');
  });
});

// ---- thread page pagination + caps -------------------------------------------

describe('getThreadPage pagination', () => {
  it('respects limit and offset', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Pagination Posts Topic',
      bodyMd: 'first',
      bodyHtml: '<p>first</p>',
      now: T1,
      rand: 'r070',
    });

    for (let i = 1; i <= 3; i++) {
      await createPost(db(), {
        topicId: topic.id,
        authorId: AUTHOR,
        bodyMd: `post ${i}`,
        bodyHtml: `<p>post ${i}</p>`,
        now: T1 + i,
      });
    }

    // 4 posts total (1 from createTopic + 3 replies).
    const page1 = await topLevelPosts(topic.id, { limit: 2 });
    expect(page1.length).toBe(2);

    const page2 = await topLevelPosts(topic.id, { limit: 2, offset: 2 });
    expect(page2.length).toBe(2);

    const page3 = await topLevelPosts(topic.id, { limit: 2, offset: 4 });
    expect(page3.length).toBe(0);

    const allIds = [...page1, ...page2].map(p => p.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('caps limit at 100', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Cap Posts Topic',
      bodyMd: 'first',
      bodyHtml: '<p>first</p>',
      now: T1,
      rand: 'r071',
    });

    const results = await topLevelPosts(topic.id, { limit: 500 });
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it('clamps negative limit: limit -1 does not bypass the row cap', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Neg Limit Posts Topic',
      bodyMd: 'first',
      bodyHtml: '<p>first</p>',
      now: T1,
      rand: 'r073',
    });

    // Add 2 more posts so the topic has 3 total.
    for (let i = 1; i <= 2; i++) {
      await createPost(db(), {
        topicId: topic.id,
        authorId: AUTHOR,
        bodyMd: `reply ${i}`,
        bodyHtml: `<p>reply ${i}</p>`,
        now: T1 + i,
      });
    }

    // limit: -1 must be clamped to 1, not passed as LIMIT -1 to SQLite.
    const negResult = await topLevelPosts(topic.id, { limit: -1 });
    expect(negResult.length).toBeGreaterThanOrEqual(1);
    expect(negResult.length).toBeLessThanOrEqual(100);

    // Explicitly: clamped to 1, so only 1 row returned even though 3 exist.
    expect(negResult.length).toBe(1);
  });

  it('excludes deleted posts', async () => {
    const { topic, firstPost } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Deleted Post Topic',
      bodyMd: 'first',
      bodyHtml: '<p>first</p>',
      now: T1,
      rand: 'r072',
    });

    await db()
      .prepare('UPDATE posts SET deleted = 1 WHERE id = ?')
      .bind(firstPost.id)
      .run();

    const posts = await topLevelPosts(topic.id);
    expect(posts.some(p => p.id === firstPost.id)).toBe(false);
  });
});

// ---- governance backfills target the mirror post ----------------------------

// Both gov-sync backfills must write to a governance topic's mirror post: the
// opening post the sync itself wrote. Identifying it as the topic's oldest post
// is wrong, because a vote-rationale cross-post is dated at its on-chain vote
// time and can predate the mirror post's date. The timestamps below are the
// shape of a real preprod topic ("Motion of No Confidence (Test Proposal)"),
// where the rationale is the older of the two top-level posts.
const MIRROR_AT = 1_783_209_600_000;
const RATIONALE_AT = 1_782_473_700_000;

async function govTopicWithEarlierRationale(suffix: string) {
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'governance',
    authorId: GOV_SYNC_AUTHOR,
    title: `Motion of No Confidence (${suffix})`,
    bodyMd: 'Abstract unavailable',
    bodyHtml: '<p>Abstract unavailable</p>',
    source: 'governance',
    now: MIRROR_AT,
    postedAt: MIRROR_AT,
    rand: suffix,
  });

  const rationaleAuthor = `drep-${suffix}`;
  await upsertVoteRationalePost(db(), {
    topicId: topic.id,
    authorId: rationaleAuthor,
    vote: 'no',
    bodyMd: 'I voted no because the committee still has work to finish.',
    bodyHtml: '<p>I voted no because the committee still has work to finish.</p>',
    now: RATIONALE_AT,
  });

  const rationale = await db()
    .prepare(`SELECT id FROM posts WHERE topic_id = ? AND source = 'vote_rationale'`)
    .bind(topic.id)
    .first<{ id: string }>();

  return { topic, mirrorPostId: firstPost.id, rationalePostId: rationale!.id };
}

const readPost = (id: string) =>
  db()
    .prepare('SELECT body_md, created_at FROM posts WHERE id = ?')
    .bind(id)
    .first<{ body_md: string; created_at: number }>();

describe('setGovTopicTitleAndBody', () => {
  it('rewrites the mirror post, not an older vote-rationale cross-post', async () => {
    const { topic, mirrorPostId, rationalePostId } = await govTopicWithEarlierRationale('gmb1');

    await setGovTopicTitleAndBody(db(), {
      topicId: topic.id,
      title: 'Motion of No Confidence',
      bodyMd: 'The real abstract, fetched on retry.',
      bodyHtml: '<p>The real abstract, fetched on retry.</p>',
    });

    expect((await readPost(mirrorPostId))!.body_md).toBe('The real abstract, fetched on retry.');
    // The DRep's own words must survive the backfill untouched.
    expect((await readPost(rationalePostId))!.body_md).toBe(
      'I voted no because the committee still has work to finish.',
    );
  });
});

describe('buildTopicPostedAtStatements', () => {
  it('stamps the mirror post, not an older vote-rationale cross-post', async () => {
    const { topic, mirrorPostId, rationalePostId } = await govTopicWithEarlierRationale('gmb2');
    const submittedAt = 1_782_000_000_000;

    await db().batch(buildTopicPostedAtStatements(db(), topic.id, submittedAt));

    expect((await readPost(mirrorPostId))!.created_at).toBe(submittedAt);
    // The cross-post keeps its on-chain vote time.
    expect((await readPost(rationalePostId))!.created_at).toBe(RATIONALE_AT);
  });

  it('moves the topic date and recomputes last_post_at from the live posts', async () => {
    const { topic } = await govTopicWithEarlierRationale('gmb3');
    const submittedAt = 1_782_000_000_000;

    await db().batch(buildTopicPostedAtStatements(db(), topic.id, submittedAt));

    const row = await db()
      .prepare('SELECT created_at, last_post_at FROM topics WHERE id = ?')
      .bind(topic.id)
      .first<{ created_at: number; last_post_at: number }>();
    expect(row!.created_at).toBe(submittedAt);
    // Newest live post wins: the rationale, which outlives the stamped mirror post.
    expect(row!.last_post_at).toBe(RATIONALE_AT);
  });
});

describe('getThreadPage opening post', () => {
  it('picks the mirror post as opener even when a cross-post is older', async () => {
    const { topic, mirrorPostId, rationalePostId } = await govTopicWithEarlierRationale('gmb4');

    const page = await getThreadPage(db(), topic.id);

    // The rationale sorts first on the page, but the opener is the mirror post:
    // the opener carries the system identity and loses its Reply button, so a
    // DRep's post taking the role would misattribute it.
    expect(page.topLevel[0].id).toBe(rationalePostId);
    expect(page.openingPost?.id).toBe(mirrorPostId);
    expect(page.stats?.participants).toBe(2);
  });
});

// ---- getTopicsByIds ---------------------------------------------------------

describe('getTopicsByIds', () => {
  it('returns a map of the requested topics, skipping unknown ids', async () => {
    const a = await createTopic(db(), { categorySlug: 'general', authorId: AUTHOR, title: 'Topic A', bodyMd: 'a', bodyHtml: '<p>a</p>', now: T1, rand: 'gi1' });
    const b = await createTopic(db(), { categorySlug: 'general', authorId: AUTHOR, title: 'Topic B', bodyMd: 'b', bodyHtml: '<p>b</p>', now: T2, rand: 'gi2' });

    const map = await getTopicsByIds(db(), [a.topic.id, b.topic.id, 'missing']);
    expect(map.size).toBe(2);
    expect(map.get(a.topic.id)!.title).toBe('Topic A');
    expect(map.get(b.topic.id)!.slug).toBe(b.topic.slug);
  });

  it('returns an empty map for empty input', async () => {
    const map = await getTopicsByIds(db(), []);
    expect(map.size).toBe(0);
  });
});

// ---- getPostsByAuthor -------------------------------------------------------

describe('getPostsByAuthor', () => {
  it('returns the author posts newest-first with topic title and slug', async () => {
    const { topic } = await createTopic(env.DB, {
      categorySlug: 'general', authorId: 'author-x', title: 'Hello World',
      bodyMd: 'a', bodyHtml: '<p>a</p>', now: 1000, rand: 'aaaa',
    });
    await createPost(env.DB, { topicId: topic.id, authorId: 'author-x', bodyMd: 'b', bodyHtml: '<p>b</p>', now: 2000 });

    const rows = await getPostsByAuthor(env.DB, 'author-x', { limit: 10, offset: 0 });
    expect(rows.length).toBe(2);
    expect(rows[0].created_at).toBe(2000); // newest first
    expect(rows[0].topic_title).toBe('Hello World');
    expect(rows[0].topic_slug).toBe(topic.slug);
    // The later post is a comment, the topic-opening post is the start.
    expect(rows[0].is_topic_start).toBe(0);
    expect(rows[1].is_topic_start).toBe(1);
  });

  it('marks a comment in someone else\'s topic as not a topic start', async () => {
    const { topic } = await createTopic(env.DB, {
      categorySlug: 'general', authorId: 'author-owner', title: 'Owned Topic',
      bodyMd: 'a', bodyHtml: '<p>a</p>', now: 1000, rand: 'bbbb',
    });
    await createPost(env.DB, { topicId: topic.id, authorId: 'author-guest', bodyMd: 'b', bodyHtml: '<p>b</p>', now: 1000 });

    const rows = await getPostsByAuthor(env.DB, 'author-guest', { limit: 10, offset: 0 });
    expect(rows.length).toBe(1);
    // Same created_at as the topic but a different author: still a comment.
    expect(rows[0].is_topic_start).toBe(0);
  });

  it('excludes deleted and hidden posts', async () => {
    const rows = await getPostsByAuthor(env.DB, 'nobody-here', { limit: 10, offset: 0 });
    expect(rows).toEqual([]);
  });
});

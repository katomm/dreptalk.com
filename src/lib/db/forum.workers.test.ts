// Forum D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises all forum.ts functions against the real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getThreadPage,
  createTopic,
  getTopicBySlug,
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

    expect(topic.source).toBe('user');
    // Integer flags map to JS booleans.
    expect(topic.pinned).toBe(false);
    expect(topic.locked).toBe(false);
    expect(topic.deleted).toBe(false);
  });

  it.each(['governance', 'survey'] as const)('accepts source "%s" and emits no topic_created event', async (source) => {
    const { topic } = await createTopic(db(), {
      categorySlug: source === 'survey' ? 'surveys' : 'governance',
      authorId: AUTHOR,
      title: `System Topic ${source}`,
      bodyMd: 'system body',
      bodyHtml: '<p>system body</p>',
      source,
      now: T1,
      rand: `r003${source[0]}`,
    });
    expect(topic.source).toBe(source);
    const events = await db()
      .prepare('SELECT COUNT(*) AS n FROM activity WHERE topic_id = ?')
      .bind(topic.id)
      .first<{ n: number }>();
    expect(events?.n).toBe(0);
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

  it('returns null for a deleted topic', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: AUTHOR,
      title: 'Deleted Topic',
      bodyMd: 'body',
      bodyHtml: '<p>body</p>',
      now: T1,
      rand: 'r011',
    });
    await db().prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(topic.id).run();

    expect(await getTopicBySlug(db(), topic.slug)).toBeNull();
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

// ---- thread page limit clamp + deleted posts --------------------------------

describe('getThreadPage filters and limits', () => {
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
    expect(page.participants).toBe(2);
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

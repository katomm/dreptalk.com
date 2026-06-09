/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the topics and posts tables.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
// Callers are responsible for rendering/sanitizing markdown before passing bodyHtml.

import { sqlPlaceholders } from './sql.js';

export interface Topic {
  id: string;
  category_slug: string;
  author_id: string;
  source: 'user' | 'governance';
  title: string;
  slug: string;
  pinned: boolean;
  locked: boolean;
  deleted: boolean;
  flag_count: number;
  post_count: number;
  last_post_at: number;
  created_at: number;
}

export interface Post {
  id: string;
  topic_id: string;
  author_id: string;
  /** Populated by createTopic/createPost; omitted by getPostsByTopic (use body_html for display). */
  body_md?: string;
  body_html: string;
  reaction_count: number;
  flag_count: number;
  /** True once enough distinct writers flagged it; rendered as a placeholder. */
  hidden: boolean;
  edited_at: number | null;
  deleted: boolean;
  created_at: number;
}

// Raw row shapes as stored in D1 (booleans as 0/1 integers).
interface TopicRow {
  id: string;
  category_slug: string;
  author_id: string;
  source: string;
  title: string;
  slug: string;
  pinned: number;
  locked: number;
  deleted: number;
  flag_count: number;
  post_count: number;
  last_post_at: number;
  created_at: number;
}

interface PostRow {
  id: string;
  topic_id: string;
  author_id: string;
  body_md: string;
  body_html: string;
  reaction_count: number;
  flag_count: number;
  hidden: number;
  edited_at: number | null;
  deleted: number;
  created_at: number;
}

// Subset returned by getPostsByTopic (body_md excluded to avoid pulling up to 20KB/post).
interface PostRowNoBody extends Omit<PostRow, 'body_md'> {
  body_md?: never;
}

/** Maps a raw D1 row to the Topic type (0/1 integers to JS booleans). */
function rowToTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    category_slug: row.category_slug,
    author_id: row.author_id,
    source: row.source as 'user' | 'governance',
    title: row.title,
    slug: row.slug,
    pinned: row.pinned === 1,
    locked: row.locked === 1,
    deleted: row.deleted === 1,
    flag_count: row.flag_count,
    post_count: row.post_count,
    last_post_at: row.last_post_at,
    created_at: row.created_at,
  };
}

/** Maps a raw D1 row to the Post type (0/1 integers to JS booleans). */
function rowToPost(row: PostRow | PostRowNoBody): Post {
  const post: Post = {
    id: row.id,
    topic_id: row.topic_id,
    author_id: row.author_id,
    body_html: row.body_html,
    reaction_count: row.reaction_count,
    flag_count: row.flag_count,
    hidden: row.hidden === 1,
    edited_at: row.edited_at,
    deleted: row.deleted === 1,
    created_at: row.created_at,
  };
  if ('body_md' in row && row.body_md !== undefined) {
    post.body_md = row.body_md;
  }
  return post;
}

/**
 * Converts a title to a URL-safe slug and appends a random suffix.
 * Lowercase, non-alphanumeric runs become hyphens, leading/trailing hyphens
 * stripped, base capped at 60 chars before appending the suffix.
 *
 * The caller supplies `rand` so this function remains deterministic/testable.
 */
export function slugify(title: string, rand: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${base}-${rand}`;
}

/**
 * Creates a new topic and its first post atomically (D1 batch).
 * Returns the created topic and first post.
 * source defaults to 'user'.
 */
export async function createTopic(
  db: D1Database,
  args: {
    categorySlug: string;
    authorId: string;
    title: string;
    bodyMd: string;
    bodyHtml: string;
    source?: 'user' | 'governance';
    now: number;
    // Overrides the timestamp written to the topic's created_at/last_post_at and the
    // first post's created_at. Defaults to `now`. The governance sync passes the
    // on-chain submission time so a synced action's post date is its submission date.
    postedAt?: number;
    rand: string;
    // Extra statements to commit atomically in the same batch as the topic and
    // first post (e.g. a governance_actions row). Receives the new topic id.
    batchWith?: (topicId: string) => D1PreparedStatement[];
  },
): Promise<{ topic: Topic; firstPost: Post }> {
  const { categorySlug, authorId, title, bodyMd, bodyHtml, source = 'user', now, rand, batchWith } = args;
  const postedAt = args.postedAt ?? now;
  const slug = slugify(title, rand);
  const topicId = crypto.randomUUID();
  const postId = crypto.randomUUID();

  const insertTopic = db
    .prepare(
      `INSERT INTO topics
         (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(topicId, categorySlug, authorId, source, title, slug, postedAt, postedAt);

  const insertPost = db
    .prepare(
      `INSERT INTO posts
         (id, topic_id, author_id, body_md, body_html, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(postId, topicId, authorId, bodyMd, bodyHtml, postedAt);

  const extra = batchWith ? batchWith(topicId) : [];
  await db.batch([insertTopic, insertPost, ...extra]);

  // Construct return objects from the known inputs and D1 column defaults;
  // avoids a SELECT round-trip after the batch insert.
  const topic = rowToTopic({
    id: topicId,
    category_slug: categorySlug,
    author_id: authorId,
    source,
    title,
    slug,
    pinned: 0,
    locked: 0,
    deleted: 0,
    flag_count: 0,
    post_count: 1,
    last_post_at: postedAt,
    created_at: postedAt,
  });

  const firstPost = rowToPost({
    id: postId,
    topic_id: topicId,
    author_id: authorId,
    body_md: bodyMd,
    body_html: bodyHtml,
    reaction_count: 0,
    flag_count: 0,
    hidden: 0,
    edited_at: null,
    deleted: 0,
    created_at: postedAt,
  });

  return { topic, firstPost };
}

/**
 * Overwrites a topic's post-date timestamps (created_at and last_post_at) and its
 * first (system) post's created_at, atomically. Used by the governance backfill to set
 * the post date to the on-chain submission time. The post update targets only the
 * earliest post, so it is safe by construction even if a reply races in between the
 * backfill's candidate read and this call: a reply always has a later created_at than
 * the system post, so it is never the subquery's match and its timestamp is preserved.
 */
export async function setTopicPostedAt(db: D1Database, topicId: string, postedAt: number): Promise<void> {
  await db.batch([
    db.prepare('UPDATE topics SET created_at = ?, last_post_at = ? WHERE id = ?').bind(postedAt, postedAt, topicId),
    // Stamps only the earliest (system) post; never a later reply.
    db
      .prepare(
        'UPDATE posts SET created_at = ? WHERE id = (SELECT id FROM posts WHERE topic_id = ? ORDER BY created_at ASC LIMIT 1)',
      )
      .bind(postedAt, topicId),
  ]);
}

/**
 * Returns the topic for the given slug, or null if not found.
 * Parameterized SELECT.
 */
export async function getTopicBySlug(db: D1Database, slug: string): Promise<Topic | null> {
  const row = await db
    .prepare('SELECT * FROM topics WHERE slug = ?')
    .bind(slug)
    .first<TopicRow>();
  return row ? rowToTopic(row) : null;
}

/**
 * Returns non-deleted topics for the given category, ordered pinned-first then
 * by last_post_at descending. Default limit 30, capped at 100. offset >= 0.
 */
export async function getTopicsByCategory(
  db: D1Database,
  categorySlug: string,
  opts?: { limit?: number; offset?: number },
): Promise<Topic[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);

  const rows = await db
    .prepare(
      `SELECT * FROM topics
       WHERE category_slug = ? AND deleted = 0
       ORDER BY pinned DESC, last_post_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(categorySlug, limit, offset)
    .all<TopicRow>();

  return (rows.results ?? []).map(rowToTopic);
}

/**
 * Returns ALL non-deleted topics in a category (no pagination). Bounded to low-volume
 * categories: the gov-sync cron uses it (with getAllGovernanceActions) to recompute the
 * governance trending scores off the hot path. Do not use for high-volume categories.
 */
export async function getAllTopicsByCategory(db: D1Database, categorySlug: string): Promise<Topic[]> {
  const rows = await db
    .prepare('SELECT * FROM topics WHERE category_slug = ? AND deleted = 0')
    .bind(categorySlug)
    .all<TopicRow>();
  return (rows.results ?? []).map(rowToTopic);
}

/**
 * Batch-loads topics by id into a Map (no N+1 when hydrating a precomputed id order,
 * e.g. the database-ordered governance list page). Unknown ids are simply absent.
 */
export async function getTopicsByIds(db: D1Database, ids: readonly string[]): Promise<Map<string, Topic>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .prepare(`SELECT * FROM topics WHERE id IN (${sqlPlaceholders(ids)})`)
    .bind(...ids)
    .all<TopicRow>();
  const map = new Map<string, Topic>();
  for (const row of rows.results ?? []) map.set(row.id, rowToTopic(row));
  return map;
}

/**
 * Returns non-deleted posts for the given topic, ordered by created_at ascending.
 * Hidden posts ARE returned (unlike deleted ones): the view renders them as a
 * placeholder so the community-flag outcome is visible in the thread.
 * Default limit 50, capped at 100. offset >= 0.
 */
export async function getPostsByTopic(
  db: D1Database,
  topicId: string,
  opts?: { limit?: number; offset?: number },
): Promise<Post[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);

  const rows = await db
    .prepare(
      `SELECT id, topic_id, author_id, body_html, reaction_count, flag_count, hidden, edited_at, deleted, created_at
       FROM posts
       WHERE topic_id = ? AND deleted = 0
       ORDER BY created_at ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(topicId, limit, offset)
    .all<PostRowNoBody>();

  return (rows.results ?? []).map(rowToPost);
}

/**
 * Returns the newest non-deleted topics across ALL categories, ordered by last
 * activity. Powers the forum overview's "latest activity" column. Uses the
 * idx_topics_last_post index. Default limit 20, capped at 50.
 */
export async function getLatestTopicsAcrossCategories(
  db: D1Database,
  opts?: { limit?: number; offset?: number },
): Promise<Topic[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 50);
  const offset = Math.max(opts?.offset ?? 0, 0);

  const rows = await db
    .prepare(
      `SELECT * FROM topics
       WHERE deleted = 0
       ORDER BY last_post_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<TopicRow>();

  return (rows.results ?? []).map(rowToTopic);
}

/**
 * Returns per-category topic counts and last-activity time in one grouped query
 * (no per-category round-trips). Powers the overview's category column.
 */
export async function getCategoryStats(
  db: D1Database,
): Promise<Map<string, { topicCount: number; lastPostAt: number | null }>> {
  const rows = (
    await db
      .prepare(
        `SELECT category_slug, COUNT(*) AS topic_count, MAX(last_post_at) AS last_post_at
         FROM topics WHERE deleted = 0 GROUP BY category_slug`,
      )
      .all<{ category_slug: string; topic_count: number; last_post_at: number | null }>()
  ).results ?? [];

  const map = new Map<string, { topicCount: number; lastPostAt: number | null }>();
  for (const r of rows) {
    map.set(r.category_slug, { topicCount: r.topic_count, lastPostAt: r.last_post_at });
  }
  return map;
}

/**
 * Returns a single post by id, or null if missing. The 20KB body_md is excluded
 * (like getPostsByTopic): the flag handler only needs author_id/deleted/hidden.
 */
export async function getPostById(db: D1Database, postId: string): Promise<Post | null> {
  const row = await db
    .prepare(
      `SELECT id, topic_id, author_id, body_html, reaction_count, flag_count, hidden, edited_at, deleted, created_at
       FROM posts WHERE id = ?`,
    )
    .bind(postId)
    .first<PostRowNoBody>();
  return row ? rowToPost(row) : null;
}

/**
 * Creates a reply post in an existing topic.
 * Throws 'topic_not_found' if the topic does not exist or is deleted.
 * Throws 'topic_locked' if the topic is locked.
 * On success, increments post_count and updates last_post_at on the topic.
 * Returns the created post.
 */
export async function createPost(
  db: D1Database,
  args: {
    topicId: string;
    authorId: string;
    bodyMd: string;
    bodyHtml: string;
    now: number;
  },
): Promise<Post> {
  const { topicId, authorId, bodyMd, bodyHtml, now } = args;

  const topicRow = await db
    .prepare('SELECT id, deleted, locked FROM topics WHERE id = ?')
    .bind(topicId)
    .first<Pick<TopicRow, 'id' | 'deleted' | 'locked'>>();

  if (!topicRow || topicRow.deleted === 1) {
    throw new Error('topic_not_found');
  }
  if (topicRow.locked === 1) {
    throw new Error('topic_locked');
  }

  const postId = crypto.randomUUID();

  const insertPost = db
    .prepare(
      `INSERT INTO posts
         (id, topic_id, author_id, body_md, body_html, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(postId, topicId, authorId, bodyMd, bodyHtml, now);

  const updateTopic = db
    .prepare(
      'UPDATE topics SET post_count = post_count + 1, last_post_at = ? WHERE id = ?',
    )
    .bind(now, topicId);

  await db.batch([insertPost, updateTopic]);

  // Construct the return value from known inputs and column defaults.
  return rowToPost({
    id: postId,
    topic_id: topicId,
    author_id: authorId,
    body_md: bodyMd,
    body_html: bodyHtml,
    reaction_count: 0,
    flag_count: 0,
    hidden: 0,
    edited_at: null,
    deleted: 0,
    created_at: now,
  });
}

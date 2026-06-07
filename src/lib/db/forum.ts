/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the topics and posts tables.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
// Callers are responsible for rendering/sanitizing markdown before passing bodyHtml.

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
    rand: string;
    // Extra statements to commit atomically in the same batch as the topic and
    // first post (e.g. a governance_actions row). Receives the new topic id.
    batchWith?: (topicId: string) => D1PreparedStatement[];
  },
): Promise<{ topic: Topic; firstPost: Post }> {
  const { categorySlug, authorId, title, bodyMd, bodyHtml, source = 'user', now, rand, batchWith } = args;
  const slug = slugify(title, rand);
  const topicId = crypto.randomUUID();
  const postId = crypto.randomUUID();

  const insertTopic = db
    .prepare(
      `INSERT INTO topics
         (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(topicId, categorySlug, authorId, source, title, slug, now, now);

  const insertPost = db
    .prepare(
      `INSERT INTO posts
         (id, topic_id, author_id, body_md, body_html, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(postId, topicId, authorId, bodyMd, bodyHtml, now);

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
    last_post_at: now,
    created_at: now,
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
    created_at: now,
  });

  return { topic, firstPost };
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
 * Returns a single post by id (including its body), or null if missing.
 * Used by the flag handler to authorize the action against the post's author.
 */
export async function getPostById(db: D1Database, postId: string): Promise<Post | null> {
  const row = await db
    .prepare('SELECT * FROM posts WHERE id = ?')
    .bind(postId)
    .first<PostRow>();
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

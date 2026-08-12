/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the topics and posts tables.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
// Callers are responsible for rendering/sanitizing markdown before passing bodyHtml.

import { sqlPlaceholders } from './sql.js';
import { activityInsert } from './activity.js';
import { isWithinGrace } from '../forum/editPolicy.js';

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
  /** Set when the title has been edited (marker only; no stored prior titles). */
  title_edited_at: number | null;
  /** The co-proposer grant active at write time, or null for a personal post. Immutable after write. */
  proposer_grant_id: string | null;
}

export interface Post {
  id: string;
  topic_id: string;
  author_id: string;
  /** Top-level posts have null; replies carry their top-level parent's id. */
  parent_post_id: string | null;
  /** Populated by createTopic/createPost; omitted by the thread readers (use body_html for display). */
  body_md?: string;
  body_html: string;
  up_count: number;
  down_count: number;
  flag_count: number;
  /** True once enough distinct writers flagged it; rendered as a placeholder. */
  hidden: boolean;
  edited_at: number | null;
  deleted: boolean;
  created_at: number;
  /** 'vote_rationale' for frozen vote rationale posts; null/undefined for normal posts. */
  source?: string | null;
  /** On-chain vote value for vote_rationale posts (yes/no/abstain); null otherwise. */
  vote?: string | null;
  /** The co-proposer grant active at write time, or null for a personal post. Immutable after write. */
  proposer_grant_id: string | null;
}

// Raw row shapes as stored in D1 (booleans as 0/1 integers).
export interface TopicRow {
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
  title_edited_at: number | null;
  proposer_grant_id: string | null;
}

interface PostRow {
  id: string;
  topic_id: string;
  author_id: string;
  parent_post_id: string | null;
  body_md: string;
  body_html: string;
  up_count: number;
  down_count: number;
  flag_count: number;
  hidden: number;
  edited_at: number | null;
  deleted: number;
  created_at: number;
  source: string | null;
  vote: string | null;
  proposer_grant_id: string | null;
}

// Subset returned by the thread/post readers (body_md excluded to avoid
// pulling up to 20KB/post).
interface PostRowNoBody extends Omit<PostRow, 'body_md'> {
  body_md?: never;
}

// The display column list shared by every post reader (body_md excluded).
const POST_COLUMNS =
  'id, topic_id, author_id, parent_post_id, body_html, up_count, down_count, flag_count, hidden, edited_at, deleted, created_at, source, vote, proposer_grant_id';

/** Maps a raw D1 row to the Topic type (0/1 integers to JS booleans). */
export function rowToTopic(row: TopicRow): Topic {
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
    title_edited_at: row.title_edited_at,
    proposer_grant_id: row.proposer_grant_id,
  };
}

/** Maps a raw D1 row to the Post type (0/1 integers to JS booleans). */
function rowToPost(row: PostRow | PostRowNoBody): Post {
  const post: Post = {
    id: row.id,
    topic_id: row.topic_id,
    author_id: row.author_id,
    parent_post_id: row.parent_post_id,
    body_html: row.body_html,
    up_count: row.up_count,
    down_count: row.down_count,
    flag_count: row.flag_count,
    hidden: row.hidden === 1,
    edited_at: row.edited_at,
    deleted: row.deleted === 1,
    created_at: row.created_at,
    source: row.source ?? null,
    vote: row.vote ?? null,
    proposer_grant_id: row.proposer_grant_id ?? null,
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
    // The co-proposer grant active at write time, or null/omitted for a
    // personal post. Stamped on both the topic and its first post.
    proposerGrantId?: string | null;
    // Extra statements to commit atomically in the same batch as the topic and
    // first post (e.g. a governance_actions row). Receives the new topic id.
    batchWith?: (topicId: string) => D1PreparedStatement[];
  },
): Promise<{ topic: Topic; firstPost: Post }> {
  const { categorySlug, authorId, title, bodyMd, bodyHtml, source = 'user', now, rand, batchWith } = args;
  const postedAt = args.postedAt ?? now;
  const proposerGrantId = args.proposerGrantId ?? null;
  const slug = slugify(title, rand);
  const topicId = crypto.randomUUID();
  const postId = crypto.randomUUID();

  const insertTopic = db
    .prepare(
      `INSERT INTO topics
         (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, proposer_grant_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(topicId, categorySlug, authorId, source, title, slug, postedAt, postedAt, proposerGrantId);

  const insertPost = db
    .prepare(
      `INSERT INTO posts
         (id, topic_id, author_id, body_md, body_html, created_at, proposer_grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(postId, topicId, authorId, bodyMd, bodyHtml, postedAt, proposerGrantId);

  const extra = batchWith ? batchWith(topicId) : [];
  // A user-created topic emits a 'topic_created' event in the same atomic batch.
  // Governance-sourced topics are emitted by gov sync as 'gov_created' (it has
  // the on-chain action context), so they emit nothing here.
  const events =
    source === 'user'
      ? [activityInsert(db, { type: 'topic_created', topicId, actorId: authorId, createdAt: postedAt })]
      : [];
  await db.batch([insertTopic, insertPost, ...events, ...extra]);

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
    title_edited_at: null,
    proposer_grant_id: proposerGrantId,
  });

  const firstPost = rowToPost({
    id: postId,
    topic_id: topicId,
    author_id: authorId,
    parent_post_id: null,
    body_md: bodyMd,
    body_html: bodyHtml,
    up_count: 0,
    down_count: 0,
    flag_count: 0,
    hidden: 0,
    edited_at: null,
    deleted: 0,
    created_at: postedAt,
    source: null,
    vote: null,
    proposer_grant_id: proposerGrantId,
  });

  return { topic, firstPost };
}

/**
 * Statements that move a topic's post date: stamp the earliest (system) post
 * with `postedAt`, then set the topic's created_at to it and recompute
 * last_post_at from the live posts. Used by the governance backfill to set the
 * post date to the on-chain submission time. Recomputing (instead of assigning)
 * last_post_at makes replied topics keep their reply-driven ordering and makes
 * a reply that raced the caller's candidate read harmless by construction; a
 * reply is always later than the system post, so it is never the earliest-post
 * subquery's match either. Returned in execution order for one db.batch, so the
 * move is atomic; callers may append related statements to the same batch.
 */
export function buildTopicPostedAtStatements(db: D1Database, topicId: string, postedAt: number): D1PreparedStatement[] {
  return [
    // Stamps only the earliest (system) post; never a later reply.
    db
      .prepare(
        'UPDATE posts SET created_at = ? WHERE id = (SELECT id FROM posts WHERE topic_id = ? ORDER BY created_at ASC LIMIT 1)',
      )
      .bind(postedAt, topicId),
    // Runs after the stamp above (batch order), so the recompute sees it. The
    // COALESCE keeps a postless topic (not possible for governance topics, but
    // cheap to guard) from nulling last_post_at.
    db
      .prepare(
        `UPDATE topics SET created_at = ?,
           last_post_at = COALESCE((SELECT MAX(created_at) FROM posts WHERE topic_id = ? AND deleted = 0), ?)
         WHERE id = ?`,
      )
      .bind(postedAt, topicId, postedAt, topicId),
  ];
}

/**
 * Corrects a governance topic's title and its opening (system) post body in one
 * atomic batch. Used by the metadata backfill when an anchor that was unreachable
 * at discovery (so the topic got a fallback title and an "abstract unavailable"
 * opening post) is fetched successfully later. The slug is intentionally left
 * unchanged so existing links stay valid, and title_edited_at is NOT set (this is
 * a system correction, not a human edit). The post update targets only the
 * earliest top-level post, so a racing reply (always later) is never affected.
 */
export async function setGovTopicTitleAndBody(
  db: D1Database,
  args: { topicId: string; title: string; bodyMd: string; bodyHtml: string },
): Promise<void> {
  await db.batch([
    db.prepare('UPDATE topics SET title = ? WHERE id = ?').bind(args.title, args.topicId),
    db
      .prepare(
        `UPDATE posts SET body_md = ?, body_html = ?
         WHERE id = (SELECT id FROM posts WHERE topic_id = ? AND parent_post_id IS NULL ORDER BY created_at ASC LIMIT 1)`,
      )
      .bind(args.bodyMd, args.bodyHtml, args.topicId),
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
 * The busiest recent thread: among topics with any activity since the given
 * time (ms), the one with the most posts. Powers the /home/ discussions
 * teaser; returns null when the window saw no activity at all.
 */
export async function getMostRepliedRecentTopic(db: D1Database, sinceMs: number): Promise<Topic | null> {
  const row = await db
    .prepare(
      `SELECT * FROM topics
       WHERE deleted = 0 AND last_post_at > ?
       ORDER BY post_count DESC, last_post_at DESC
       LIMIT 1`,
    )
    .bind(sinceMs)
    .first<TopicRow>();
  return row ? rowToTopic(row) : null;
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
 * (like the thread readers): the flag handler only needs author_id/deleted/hidden.
 */
export async function getPostById(db: D1Database, postId: string): Promise<Post | null> {
  const row = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`)
    .bind(postId)
    .first<PostRowNoBody>();
  return row ? rowToPost(row) : null;
}

/** The opening post's HTML for a topic (oldest top-level, visible), for previews. */
export async function getOpeningPostBody(db: D1Database, topicId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT body_html FROM posts
       WHERE topic_id = ? AND parent_post_id IS NULL AND deleted = 0 AND hidden = 0
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(topicId)
    .first<{ body_html: string }>();
  return row?.body_html ?? null;
}

/**
 * Distinct author ids participating in a thread: the topic author plus every
 * visible poster. Crossposted vote-rationale posts do not make their author a
 * participant (a frozen rationale is not a contribution to the discussion).
 * Used by the reply-notification fan-out.
 */
export async function getThreadParticipantIds(db: D1Database, topicId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT author_id AS id FROM posts
         WHERE topic_id = ?1 AND deleted = 0 AND hidden = 0
           AND (source IS NULL OR source != 'vote_rationale')
       UNION
       SELECT author_id AS id FROM topics WHERE id = ?1`,
    )
    .bind(topicId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** A post by one author, with its topic's title and slug for linking on a profile. */
export interface AuthorPost {
  id: string;
  topic_id: string;
  topic_title: string;
  topic_slug: string;
  /**
   * 1 when this post opened its topic (createTopic writes topic and first post
   * with the same author and timestamp), 0 for any later post. parent_post_id
   * cannot tell these apart: it is NULL for every top-level post of a thread.
   */
  is_topic_start: number;
  body_html: string;
  created_at: number;
}

/**
 * Posts authored by one user (newest first), joined to their topic for context
 * and linking. Excludes deleted and hidden posts and posts in deleted topics.
 * Uses idx_posts_author. Default limit 20, capped 50.
 */
export async function getPostsByAuthor(
  db: D1Database,
  authorId: string,
  opts?: { limit?: number; offset?: number },
): Promise<AuthorPost[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 50);
  const offset = Math.max(opts?.offset ?? 0, 0);

  const rows = (
    await db
      .prepare(
        `SELECT p.id, p.topic_id, t.title AS topic_title, t.slug AS topic_slug,
                (p.author_id = t.author_id AND p.created_at = t.created_at) AS is_topic_start,
                p.body_html, p.created_at
         FROM posts p
         JOIN topics t ON t.id = p.topic_id
         WHERE p.author_id = ? AND p.deleted = 0 AND p.hidden = 0 AND t.deleted = 0
         ORDER BY p.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(authorId, limit, offset)
      .all<AuthorPost>()
  ).results ?? [];
  return rows;
}

/**
 * Creates a reply post in an existing topic.
 * Throws 'topic_not_found' if the topic does not exist or is deleted.
 * Throws 'topic_locked' if the topic is locked.
 * Throws 'parent_not_found' if parentPostId names no live post of this topic.
 * Threads are exactly one level deep: replying to a reply attaches the new
 * post to that reply's own top-level parent.
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
    /** Optional reply target; resolved to its top-level parent when nested. */
    parentPostId?: string | null;
    // The co-proposer grant active at write time, or null/omitted for a personal post.
    proposerGrantId?: string | null;
  },
): Promise<Post> {
  const { topicId, authorId, bodyMd, bodyHtml, now } = args;
  const proposerGrantId = args.proposerGrantId ?? null;

  // Topic and parent lookups are independent, so they go through one batch.
  const lookups = [
    db
      .prepare('SELECT id, deleted, locked FROM topics WHERE id = ?')
      .bind(topicId),
  ];
  if (args.parentPostId) {
    lookups.push(
      db
        .prepare('SELECT id, topic_id, parent_post_id, deleted FROM posts WHERE id = ?')
        .bind(args.parentPostId),
    );
  }
  const lookupResults = await db.batch(lookups);

  const topicRow = lookupResults[0]?.results?.[0] as
    | Pick<TopicRow, 'id' | 'deleted' | 'locked'>
    | undefined;
  if (!topicRow || topicRow.deleted === 1) {
    throw new Error('topic_not_found');
  }
  if (topicRow.locked === 1) {
    throw new Error('topic_locked');
  }

  let parentId: string | null = null;
  if (args.parentPostId) {
    const parent = lookupResults[1]?.results?.[0] as
      | { id: string; topic_id: string; parent_post_id: string | null; deleted: number }
      | undefined;
    if (!parent || parent.deleted === 1 || parent.topic_id !== topicId) {
      throw new Error('parent_not_found');
    }
    // Lift a reply-to-a-reply onto the top-level parent (one level, enforced).
    parentId = parent.parent_post_id ?? parent.id;
  }

  const postId = crypto.randomUUID();

  const insertPost = db
    .prepare(
      `INSERT INTO posts
         (id, topic_id, author_id, parent_post_id, body_md, body_html, created_at, proposer_grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(postId, topicId, authorId, parentId, bodyMd, bodyHtml, now, proposerGrantId);

  const updateTopic = db
    .prepare(
      'UPDATE topics SET post_count = post_count + 1, last_post_at = ? WHERE id = ?',
    )
    .bind(now, topicId);

  await db.batch([
    insertPost,
    updateTopic,
    // The reply is a feed event; emit it atomically with the post.
    activityInsert(db, { type: 'reply_created', topicId, actorId: authorId, refPostId: postId, createdAt: now }),
  ]);

  // Construct the return value from known inputs and column defaults.
  return rowToPost({
    id: postId,
    topic_id: topicId,
    author_id: authorId,
    parent_post_id: parentId,
    body_md: bodyMd,
    body_html: bodyHtml,
    up_count: 0,
    down_count: 0,
    flag_count: 0,
    hidden: 0,
    edited_at: null,
    deleted: 0,
    created_at: now,
    source: null,
    vote: null,
    proposer_grant_id: proposerGrantId,
  });
}

/**
 * Edits a post's body. Within the grace window (isWithinGrace) the edit is
 * silent: the body is replaced and nothing else changes. Past the window the
 * current body is archived into post_revisions and edited_at is stamped, both in
 * one batch. Throws on a missing/deleted post, a non-owner, a hidden post, or a
 * missing/deleted/locked topic. Returns whether a revision was archived.
 */
export async function editPost(
  db: D1Database,
  args: {
    postId: string;
    authorId: string;
    bodyMd: string;
    bodyHtml: string;
    now: number;
    // The editing session's grant id, or null for a personal session. Must match
    // the post's stored proposer_grant_id (mandate_mismatch otherwise).
    sessionGrantId: string | null;
  },
): Promise<{ edited: boolean }> {
  const { postId, authorId, bodyMd, bodyHtml, now, sessionGrantId } = args;

  // Load the post WITH its body (needed to archive the prior version), then its
  // topic's state (depends on post.topic_id). Two sequential reads.
  const post = await db
    .prepare(
      'SELECT id, topic_id, author_id, body_md, body_html, hidden, deleted, created_at, source, proposer_grant_id FROM posts WHERE id = ?',
    )
    .bind(postId)
    .first<{
      id: string; topic_id: string; author_id: string; body_md: string;
      body_html: string; hidden: number; deleted: number; created_at: number;
      source: string | null; proposer_grant_id: string | null;
    }>();
  if (!post || post.deleted === 1) throw new Error('post_not_found');
  if (post.author_id !== authorId) throw new Error('not_owner');
  if ((post.proposer_grant_id ?? null) !== (sessionGrantId ?? null)) {
    // A mandate post is only editable by the same active mandate; a personal
    // post never by a mandate session. Attribution is immutable either way.
    throw new Error('mandate_mismatch');
  }
  // Vote rationale posts are frozen: their body must match the on-chain hash.
  if (post.source === 'vote_rationale') throw new Error('frozen_rationale');
  if (post.hidden === 1) throw new Error('post_hidden');

  const topicRow = await db
    .prepare('SELECT deleted, locked FROM topics WHERE id = ?')
    .bind(post.topic_id)
    .first<{ deleted: number; locked: number }>();
  if (!topicRow || topicRow.deleted === 1) throw new Error('topic_not_found');
  if (topicRow.locked === 1) throw new Error('topic_locked');

  // Silent in-grace edit: replace the body only.
  if (isWithinGrace(post.created_at, now)) {
    await db
      .prepare('UPDATE posts SET body_md = ?, body_html = ? WHERE id = ?')
      .bind(bodyMd, bodyHtml, postId)
      .run();
    return { edited: false };
  }

  // Marked edit: archive the prior version, then replace + stamp, atomically.
  await db.batch([
    db
      .prepare(
        `INSERT INTO post_revisions (id, post_id, body_md, body_html, replaced_at, editor_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), postId, post.body_md, post.body_html, now, authorId),
    db
      .prepare('UPDATE posts SET body_md = ?, body_html = ?, edited_at = ? WHERE id = ?')
      .bind(bodyMd, bodyHtml, now, postId),
  ]);
  return { edited: true };
}

/**
 * Edits a user topic's title. Sets title_edited_at as the "(edited)" marker; the
 * slug is intentionally left unchanged so existing links never break, and no
 * prior title is stored (title history is a marker only). Throws on a
 * missing/deleted topic, a non-author, a governance topic, or a locked topic.
 */
export async function editTitle(
  db: D1Database,
  args: {
    topicId: string;
    authorId: string;
    title: string;
    now: number;
    // The editing session's grant id, or null for a personal session. Must match
    // the topic's stored proposer_grant_id (mandate_mismatch otherwise).
    sessionGrantId: string | null;
  },
): Promise<void> {
  const { topicId, authorId, title, now, sessionGrantId } = args;
  const topic = await db
    .prepare('SELECT author_id, source, deleted, locked, proposer_grant_id FROM topics WHERE id = ?')
    .bind(topicId)
    .first<{
      author_id: string; source: string; deleted: number; locked: number;
      proposer_grant_id: string | null;
    }>();
  if (!topic || topic.deleted === 1) throw new Error('topic_not_found');
  if (topic.source !== 'user') throw new Error('not_user_topic');
  if (topic.author_id !== authorId) throw new Error('not_owner');
  if ((topic.proposer_grant_id ?? null) !== (sessionGrantId ?? null)) {
    // A mandate topic is only editable by the same active mandate; a personal
    // topic never by a mandate session. Attribution is immutable either way.
    throw new Error('mandate_mismatch');
  }
  if (topic.locked === 1) throw new Error('topic_locked');

  await db
    .prepare('UPDATE topics SET title = ?, title_edited_at = ? WHERE id = ?')
    .bind(title, now, topicId)
    .run();
}

export interface PostVersion {
  bodyMd: string;
  bodyHtml: string;
  /**
   * When this version was written. Derived, not stored: post_revisions holds
   * replaced_at (when a version was superseded), so an archived version's creation
   * time is the replacement time of the version below it.
   *
   * Caveat for the oldest version: an edit inside the grace window rewrites a body
   * without archiving anything, so created_at is the best timestamp available for
   * that text, not necessarily the moment it was written.
   */
  createdAt: number;
  current: boolean;
}

export interface PostHistory {
  /** Newest first; index 0 is the live current body. */
  versions: PostVersion[];
  hidden: boolean;
  authorId: string;
  topicId: string;
  topicSlug: string;
  topicTitle: string;
}

/**
 * Returns a post's full version history (current body + every archived revision,
 * newest first) plus the fields the history view and its hidden-gate need.
 * Returns null when the post is missing or deleted. Public callers apply the
 * hidden-post visibility gate (a hidden post's history is author/moderator only).
 */
export async function getPostHistory(db: D1Database, postId: string): Promise<PostHistory | null> {
  const [postRes, revRes] = await db.batch([
    db
      .prepare(
        `SELECT p.body_md, p.body_html, p.edited_at, p.created_at, p.hidden, p.author_id, p.deleted,
                p.topic_id, t.slug AS topic_slug, t.title AS topic_title
         FROM posts p JOIN topics t ON t.id = p.topic_id
         WHERE p.id = ?`,
      )
      .bind(postId),
    db
      .prepare(
        'SELECT body_md, body_html, replaced_at FROM post_revisions WHERE post_id = ? ORDER BY replaced_at DESC',
      )
      .bind(postId),
  ]);

  const post = postRes.results?.[0] as
    | {
        body_md: string; body_html: string; edited_at: number | null; created_at: number;
        hidden: number; author_id: string; deleted: number;
        topic_id: string; topic_slug: string; topic_title: string;
      }
    | undefined;
  if (!post || post.deleted === 1) return null;

  const revisions = (revRes.results ?? []) as {
    body_md: string;
    body_html: string;
    replaced_at: number;
  }[];

  // Newest first. An archived version was created when the version below it was
  // replaced, and the oldest falls back to the post's own created_at.
  const versions: PostVersion[] = [
    {
      bodyMd: post.body_md,
      bodyHtml: post.body_html,
      createdAt: post.edited_at ?? post.created_at,
      current: true,
    },
    ...revisions.map((r, i) => ({
      bodyMd: r.body_md,
      bodyHtml: r.body_html,
      createdAt: i + 1 < revisions.length ? revisions[i + 1].replaced_at : post.created_at,
      current: false,
    })),
  ];

  return {
    versions,
    hidden: post.hidden === 1,
    authorId: post.author_id,
    topicId: post.topic_id,
    topicSlug: post.topic_slug,
    topicTitle: post.topic_title,
  };
}

// ---------------------------------------------------------------------------
// Thread page (one-level threading) and thread stats
// ---------------------------------------------------------------------------

export interface TopicStats {
  /** Distinct authors across the topic's live posts (system author included). */
  participants: number;
  /** Thumbs up/down on the opening post: the topic-level supporting/opposing signal. */
  supporting: number;
  opposing: number;
}

export interface ThreadPage {
  /** Top-level posts for this page, oldest first. */
  topLevel: Post[];
  /** Replies grouped by their top-level parent's id, oldest first. */
  childrenByParent: Map<string, Post[]>;
  /**
   * The topic's opening post when this page contains it (offset 0), else null.
   * The single definition the views use for the system-identity override, the
   * Reply suppression, and the meta excerpt.
   */
  openingPost: Post | null;
  /** Header-strip stats for the whole topic; null for a topic with no posts. */
  stats: TopicStats | null;
}

// The page's top-level posts: live, parentless, oldest first. Shared between
// the page query (full columns) and the children query's IN subselect (ids).
const TOP_LEVEL_PAGE_SQL = `FROM posts
   WHERE topic_id = ?1 AND deleted = 0 AND parent_post_id IS NULL
   ORDER BY created_at ASC
   LIMIT ?2 OFFSET ?3`;

/**
 * Loads everything the thread view needs in ONE batched round-trip:
 * the page's top-level posts, ALL replies to them (one level; the subselect
 * recomputes the page's parent ids so the statements stay independent), and
 * the topic-wide stats strip. Pagination counts top-level posts only, so a
 * reply always renders under its parent regardless of when it was written.
 * Hidden posts are included (rendered as placeholders); deleted ones are not.
 *
 * Assumes the one-level invariant that createPost enforces: every
 * parent_post_id names a top-level post of the same topic.
 */
export async function getThreadPage(
  db: D1Database,
  topicId: string,
  opts?: { limit?: number; offset?: number },
): Promise<ThreadPage> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);

  const [topRes, childRes, statsRes] = await db.batch([
    db.prepare(`SELECT ${POST_COLUMNS} ${TOP_LEVEL_PAGE_SQL}`).bind(topicId, limit, offset),
    db
      .prepare(
        `SELECT ${POST_COLUMNS}
         FROM posts
         WHERE parent_post_id IS NOT NULL
           AND parent_post_id IN (SELECT id ${TOP_LEVEL_PAGE_SQL})
           AND deleted = 0
         ORDER BY created_at ASC`,
      )
      .bind(topicId, limit, offset),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(DISTINCT author_id) FROM posts WHERE topic_id = ?1 AND deleted = 0) AS participants,
           p.up_count, p.down_count
         FROM posts p
         WHERE p.topic_id = ?1 AND p.deleted = 0
           AND (p.source IS NULL OR p.source != 'vote_rationale')
         ORDER BY p.created_at ASC
         LIMIT 1`,
      )
      .bind(topicId),
  ]);

  const topLevel = ((topRes.results ?? []) as PostRowNoBody[]).map(rowToPost);

  const childrenByParent = new Map<string, Post[]>();
  for (const row of (childRes.results ?? []) as PostRowNoBody[]) {
    const child = rowToPost(row);
    const parentId = child.parent_post_id as string;
    const list = childrenByParent.get(parentId);
    if (list) list.push(child);
    else childrenByParent.set(parentId, [child]);
  }

  const statsRow = statsRes.results?.[0] as
    | { participants: number; up_count: number; down_count: number }
    | undefined;
  const stats: TopicStats | null = statsRow
    ? { participants: statsRow.participants, supporting: statsRow.up_count, opposing: statsRow.down_count }
    : null;

  // The opening post is the earliest post that is NOT a frozen vote rationale.
  // A rationale is dated at its vote time, while a governance topic's opening
  // post is dated at the on-chain submission epoch start; a vote cast before
  // that epoch boundary (preprod test data) would otherwise sort first and
  // steal the opening-post role, the system identity, and the meta excerpt.
  const opening = offset === 0 ? (topLevel.find((p) => p.source !== 'vote_rationale') ?? null) : null;

  return {
    topLevel,
    childrenByParent,
    openingPost: opening,
    stats,
  };
}

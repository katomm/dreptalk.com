/// <reference types="@cloudflare/workers-types" />
// Testable handler functions for forum write operations.
// All I/O deps are injected; Astro routes are thin wrappers over these.

import { createTopic, createPost, getPostById } from '../db/forum.js';
import { flagPost, unflagPost, type FlagState } from '../db/postFlags.js';
import { renderMarkdown } from '../markdown.js';
import { getCategory, isDiscussion } from '../../../config/categories.js';
import { checkRate } from '../rate.js';
import { isWriter } from '../auth/roles.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { toBase64Url } from '../crypto/base64url.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface HandlerResult {
  status: number;
  json: unknown;
}

type User = { id: string; roles: string[] };

// ---------------------------------------------------------------------------
// handleCreateTopic
// ---------------------------------------------------------------------------

export interface CreateTopicInput {
  user: User | null;
  body: {
    categorySlug: unknown;
    title: unknown;
    bodyMd: unknown;
  };
  db: D1Database;
  rateKv: KVNamespace;
  now: number;
}

/**
 * Handles a request to create a new forum topic.
 *
 * Security: requires authenticated user, rate-limited per user,
 * validates category access, title length, and body length.
 * The markdown body is rendered and sanitized before storage.
 * Unexpected errors return 500 without leaking internal details.
 */
export async function handleCreateTopic(input: CreateTopicInput): Promise<HandlerResult> {
  try {
    const { user, body, db, rateKv, now } = input;

    // 1. Auth check.
    if (!user) {
      return { status: 401, json: { ok: false, error: 'unauthorized' } };
    }

    // 2. Rate limit: 5 topics per 600s per user.
    const allowed = await checkRate(rateKv, `topic:${user.id}`, { max: 5, windowSec: 600, now });
    if (!allowed) {
      return { status: 429, json: { ok: false, error: 'rate_limited' } };
    }

    // 3. Validate categorySlug.
    const categorySlug = typeof body.categorySlug === 'string' ? body.categorySlug : '';
    const category = getCategory(categorySlug);
    if (!category) {
      return { status: 400, json: { ok: false, error: 'unknown category' } };
    }
    if (!isDiscussion(categorySlug)) {
      return { status: 403, json: { ok: false, error: 'cannot post in this category' } };
    }

    // 4. Validate title.
    const rawTitle = typeof body.title === 'string' ? body.title : '';
    const title = rawTitle.trim();
    if (title.length < 3 || title.length > 200) {
      return { status: 400, json: { ok: false, error: 'title must be 3 to 200 characters' } };
    }

    // 5. Validate bodyMd.
    const bodyMd = (typeof body.bodyMd === 'string' ? body.bodyMd : '').trim();
    if (bodyMd.length === 0 || bodyMd.length > 20000) {
      return { status: 400, json: { ok: false, error: 'body must be 1 to 20000 characters' } };
    }

    // 6. Render and sanitize markdown.
    const bodyHtml = renderMarkdown(bodyMd);

    // 7. Generate a short CSPRNG-based suffix for the slug (~5 lowercase base64url chars, no underscores).
    const rand = toBase64Url(crypto.getRandomValues(new Uint8Array(4))).replace(/_/g, '').toLowerCase().slice(0, 8);

    // 8. Persist.
    const { topic } = await createTopic(db, {
      categorySlug,
      authorId: user.id,
      title,
      bodyMd,
      bodyHtml,
      source: 'user',
      now,
      rand,
    });

    return { status: 201, json: { ok: true, slug: topic.slug } };
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

// ---------------------------------------------------------------------------
// handleCreatePost
// ---------------------------------------------------------------------------

export interface CreatePostInput {
  user: User | null;
  topicId: string;
  body: {
    bodyMd: unknown;
  };
  db: D1Database;
  rateKv: KVNamespace;
  now: number;
}

/**
 * Handles a request to add a reply post to an existing topic.
 *
 * Security: requires authenticated user, rate-limited per user,
 * validates body length. Maps domain errors from createPost to HTTP status codes.
 * Unexpected errors return 500 without leaking internal details.
 */
export async function handleCreatePost(input: CreatePostInput): Promise<HandlerResult> {
  try {
    const { user, topicId, body, db, rateKv, now } = input;

    // 1. Auth check.
    if (!user) {
      return { status: 401, json: { ok: false, error: 'unauthorized' } };
    }

    // 2. Rate limit: 20 posts per 600s per user.
    const allowed = await checkRate(rateKv, `post:${user.id}`, { max: 20, windowSec: 600, now });
    if (!allowed) {
      return { status: 429, json: { ok: false, error: 'rate_limited' } };
    }

    // 3. Validate bodyMd.
    const bodyMd = (typeof body.bodyMd === 'string' ? body.bodyMd : '').trim();
    if (bodyMd.length === 0 || bodyMd.length > 20000) {
      return { status: 400, json: { ok: false, error: 'body must be 1 to 20000 characters' } };
    }

    // 4. Render and sanitize markdown.
    const bodyHtml = renderMarkdown(bodyMd);

    // 5. Persist. createPost throws domain errors for locked/missing topics.
    await createPost(db, { topicId, authorId: user.id, bodyMd, bodyHtml, now });

    return { status: 201, json: { ok: true } };
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'topic_locked') {
        return { status: 403, json: { ok: false, error: 'topic_locked' } };
      }
      if (err.message === 'topic_not_found') {
        return { status: 404, json: { ok: false, error: 'topic_not_found' } };
      }
    }
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

// ---------------------------------------------------------------------------
// handleFlagPost / handleUnflagPost (community flagging)
// ---------------------------------------------------------------------------

export interface FlagPostInput {
  user: User | null;
  postId: string;
  db: D1Database;
  rateKv: KVNamespace;
  now: number;
}

/** Shared gate for flag/unflag: returns the user when allowed, else a result to send. */
async function authorizeFlag(
  input: FlagPostInput,
): Promise<{ user: User } | { fail: HandlerResult }> {
  const { user, postId, db, rateKv, now } = input;

  // 1. Auth: only on-chain writers can flag.
  if (!user) {
    return { fail: { status: 401, json: { ok: false, error: 'unauthorized' } } };
  }
  if (!isWriter(user.roles)) {
    return { fail: { status: 403, json: { ok: false, error: 'forbidden' } } };
  }

  // 2. Rate limit toggles per user (30 per 600s).
  const allowed = await checkRate(rateKv, `flag:${user.id}`, { max: 30, windowSec: 600, now });
  if (!allowed) {
    return { fail: { status: 429, json: { ok: false, error: 'rate_limited' } } };
  }

  // 3. The post must exist and not be deleted.
  const post = await getPostById(db, postId);
  if (!post || post.deleted) {
    return { fail: { status: 404, json: { ok: false, error: 'post_not_found' } } };
  }

  // 4. You cannot flag your own post or a system/governance post.
  if (post.author_id === user.id) {
    return { fail: { status: 403, json: { ok: false, error: 'cannot_flag_own' } } };
  }
  if (post.author_id === GOV_SYNC_AUTHOR) {
    return { fail: { status: 403, json: { ok: false, error: 'cannot_flag_system' } } };
  }

  return { user };
}

function flagResult(state: FlagState, flagged: boolean): HandlerResult {
  return { status: 200, json: { ok: true, flagged, flagCount: state.flagCount, hidden: state.hidden } };
}

/**
 * Records a community flag on a post. After 3 distinct writers flag it, the post
 * is hidden. Idempotent: re-flagging by the same writer does not change the count.
 * Unexpected errors return 500 without leaking internal details.
 */
export async function handleFlagPost(input: FlagPostInput): Promise<HandlerResult> {
  try {
    const gate = await authorizeFlag(input);
    if ('fail' in gate) return gate.fail;

    const state = await flagPost(input.db, {
      postId: input.postId,
      flaggerId: gate.user.id,
      now: input.now,
    });
    return flagResult(state, true);
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

/**
 * Withdraws the caller's flag from a post. If the distinct count drops below the
 * threshold, the post un-hides. Unexpected errors return 500.
 */
export async function handleUnflagPost(input: FlagPostInput): Promise<HandlerResult> {
  try {
    const gate = await authorizeFlag(input);
    if ('fail' in gate) return gate.fail;

    const state = await unflagPost(input.db, { postId: input.postId, flaggerId: gate.user.id });
    return flagResult(state, false);
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

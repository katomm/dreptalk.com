/// <reference types="@cloudflare/workers-types" />
// Testable handler functions for forum write operations.
// All I/O deps are injected; Astro routes are thin wrappers over these.

import { createTopic, createPost, getPostById } from '../db/forum.js';
import { flagPost, unflagPost, type FlagState } from '../db/postFlags.js';
import { setReaction, clearReaction, isReaction, type ReactionState, type Reaction } from '../db/postReactions.js';
import { renderMarkdown } from '../markdown.js';
import { getCategory, isDiscussion } from '../../../config/categories.js';
import { checkRate } from '../rate.js';
import type { RateLimiter } from '../rateLimiterDO.js';
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
  rateLimiter: DurableObjectNamespace<RateLimiter>;
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
    const { user, body, db, rateLimiter, now } = input;

    // 1. Auth check: must be authenticated and hold an on-chain writer role.
    // Reading is public; posting is reserved for verified DReps/SPOs/CC/proposers
    // (same gate as flagging). Moderation roles alone do not grant write access.
    if (!user) {
      return { status: 401, json: { ok: false, error: 'unauthorized' } };
    }
    if (!isWriter(user.roles)) {
      return { status: 403, json: { ok: false, error: 'forbidden' } };
    }

    // 2. Rate limit: 5 topics per 600s per user.
    const allowed = await checkRate(rateLimiter, `topic:${user.id}`, { max: 5, windowSec: 600, now });
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
    /** Optional reply target (one-level threading). */
    parentPostId?: unknown;
  };
  db: D1Database;
  rateLimiter: DurableObjectNamespace<RateLimiter>;
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
    const { user, topicId, body, db, rateLimiter, now } = input;

    // 1. Auth check: must be authenticated and hold an on-chain writer role
    // (same gate as topic creation and flagging).
    if (!user) {
      return { status: 401, json: { ok: false, error: 'unauthorized' } };
    }
    if (!isWriter(user.roles)) {
      return { status: 403, json: { ok: false, error: 'forbidden' } };
    }

    // 2. Rate limit: 20 posts per 600s per user.
    const allowed = await checkRate(rateLimiter, `post:${user.id}`, { max: 20, windowSec: 600, now });
    if (!allowed) {
      return { status: 429, json: { ok: false, error: 'rate_limited' } };
    }

    // 3. Validate bodyMd and the optional reply target.
    const bodyMd = (typeof body.bodyMd === 'string' ? body.bodyMd : '').trim();
    if (bodyMd.length === 0 || bodyMd.length > 20000) {
      return { status: 400, json: { ok: false, error: 'body must be 1 to 20000 characters' } };
    }
    const parentPostId = body.parentPostId ?? null;
    if (parentPostId !== null && typeof parentPostId !== 'string') {
      return { status: 400, json: { ok: false, error: 'invalid parent post id' } };
    }

    // 4. Render and sanitize markdown.
    const bodyHtml = renderMarkdown(bodyMd);

    // 5. Persist. createPost throws domain errors for locked/missing targets.
    const post = await createPost(db, { topicId, authorId: user.id, bodyMd, bodyHtml, now, parentPostId });

    // The id lets the client land on the new post after the reload.
    return { status: 201, json: { ok: true, postId: post.id } };
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'topic_locked') {
        return { status: 403, json: { ok: false, error: 'topic_locked' } };
      }
      if (err.message === 'topic_not_found') {
        return { status: 404, json: { ok: false, error: 'topic_not_found' } };
      }
      if (err.message === 'parent_not_found') {
        return { status: 404, json: { ok: false, error: 'parent_not_found' } };
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
  rateLimiter: DurableObjectNamespace<RateLimiter>;
  now: number;
}

/** Shared gate for flag/unflag: returns the user when allowed, else a result to send. */
async function authorizeFlag(
  input: FlagPostInput,
): Promise<{ user: User } | { fail: HandlerResult }> {
  const { user, postId, db, rateLimiter, now } = input;

  // 1. Auth: only on-chain writers can flag.
  if (!user) {
    return { fail: { status: 401, json: { ok: false, error: 'unauthorized' } } };
  }
  if (!isWriter(user.roles)) {
    return { fail: { status: 403, json: { ok: false, error: 'forbidden' } } };
  }

  // 2 + 3. Rate limit (30 toggles per 600s per user) and post lookup are
  // independent round-trips (DO vs D1), so they run concurrently. The rate
  // verdict is checked first to keep the error precedence.
  const [allowed, post] = await Promise.all([
    checkRate(rateLimiter, `flag:${user.id}`, { max: 30, windowSec: 600, now }),
    getPostById(db, postId),
  ]);
  if (!allowed) {
    return { fail: { status: 429, json: { ok: false, error: 'rate_limited' } } };
  }
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
 * Shared flag/unflag flow. `flag` true records a community flag (after 3 distinct
 * writers flag a post it is hidden); `flag` false withdraws the caller's flag,
 * un-hiding the post if the count drops below the threshold. Flagging is
 * idempotent per writer. Unexpected errors return 500 without leaking detail.
 */
async function handleFlagToggle(input: FlagPostInput, flag: boolean): Promise<HandlerResult> {
  try {
    const gate = await authorizeFlag(input);
    if ('fail' in gate) return gate.fail;

    const state = flag
      ? await flagPost(input.db, { postId: input.postId, flaggerId: gate.user.id, now: input.now })
      : await unflagPost(input.db, { postId: input.postId, flaggerId: gate.user.id });
    return flagResult(state, flag);
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

export const handleFlagPost = (input: FlagPostInput): Promise<HandlerResult> =>
  handleFlagToggle(input, true);

export const handleUnflagPost = (input: FlagPostInput): Promise<HandlerResult> =>
  handleFlagToggle(input, false);

// ---------------------------------------------------------------------------
// handleReactToPost / handleClearReaction (thumbs up / thumbs down)
// ---------------------------------------------------------------------------

export interface ReactPostInput {
  user: User | null;
  postId: string;
  db: D1Database;
  rateLimiter: DurableObjectNamespace<RateLimiter>;
  now: number;
}

/**
 * Shared react/withdraw flow. A writer holds at most one reaction per post;
 * setting the other side replaces it. Unlike flagging, reacting to a system
 * (governance) post is allowed: the opening post of a governance action is
 * exactly what readers want to signal support or opposition on. Reacting to
 * your own post is not. Unexpected errors return 500 without leaking detail.
 */
async function handleReactionChange(
  input: ReactPostInput,
  reaction: Reaction | null,
): Promise<HandlerResult> {
  try {
    const { user, postId, db, rateLimiter, now } = input;

    // 1. Auth: only on-chain writers can react (same gate as posting/flagging).
    if (!user) {
      return { status: 401, json: { ok: false, error: 'unauthorized' } };
    }
    if (!isWriter(user.roles)) {
      return { status: 403, json: { ok: false, error: 'forbidden' } };
    }

    // 2 + 3. Rate limit (60 toggles per 600s; reactions are lightweight) and
    // post lookup are independent round-trips (DO vs D1), so they run
    // concurrently. The rate verdict is checked first to keep error precedence.
    const [allowed, post] = await Promise.all([
      checkRate(rateLimiter, `react:${user.id}`, { max: 60, windowSec: 600, now }),
      getPostById(db, postId),
    ]);
    if (!allowed) {
      return { status: 429, json: { ok: false, error: 'rate_limited' } };
    }
    if (!post || post.deleted) {
      return { status: 404, json: { ok: false, error: 'post_not_found' } };
    }

    // 4. You cannot react to your own post.
    if (post.author_id === user.id) {
      return { status: 403, json: { ok: false, error: 'cannot_react_own' } };
    }

    const state: ReactionState = reaction
      ? await setReaction(db, { postId, reactorId: user.id, reaction, now })
      : await clearReaction(db, { postId, reactorId: user.id });

    return {
      status: 200,
      json: { ok: true, reaction, upCount: state.upCount, downCount: state.downCount },
    };
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

/** Sets the caller's reaction; 400 unless reaction is 'up' or 'down'. */
export async function handleReactToPost(
  input: ReactPostInput,
  reaction: unknown,
): Promise<HandlerResult> {
  if (!isReaction(reaction)) {
    return { status: 400, json: { ok: false, error: 'reaction must be "up" or "down"' } };
  }
  return handleReactionChange(input, reaction);
}

/** Withdraws the caller's reaction (no-op if none). */
export const handleClearReaction = (input: ReactPostInput): Promise<HandlerResult> =>
  handleReactionChange(input, null);

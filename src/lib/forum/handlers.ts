/// <reference types="@cloudflare/workers-types" />
// Testable handler functions for forum write operations.
// All I/O deps are injected; Astro routes are thin wrappers over these.

import { createTopic, createPost } from '../db/forum.js';
import { renderMarkdown } from '../markdown.js';
import { getCategory, isDiscussion, GOVERNANCE_CATEGORY_SLUG } from '../../../config/categories.js';
import { checkRate } from '../rate.js';

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
    if (categorySlug === GOVERNANCE_CATEGORY_SLUG || !isDiscussion(categorySlug)) {
      return { status: 403, json: { ok: false, error: 'cannot post in this category' } };
    }

    // 4. Validate title.
    const rawTitle = typeof body.title === 'string' ? body.title : '';
    const title = rawTitle.trim();
    if (title.length < 3 || title.length > 200) {
      return { status: 400, json: { ok: false, error: 'title must be 3 to 200 characters' } };
    }

    // 5. Validate bodyMd.
    const bodyMd = typeof body.bodyMd === 'string' ? body.bodyMd : '';
    if (bodyMd.length === 0 || bodyMd.length > 20000) {
      return { status: 400, json: { ok: false, error: 'body must be 1 to 20000 characters' } };
    }

    // 6. Render and sanitize markdown.
    const bodyHtml = renderMarkdown(bodyMd);

    // 7. Generate a short random suffix for the slug (base36, 6 chars).
    const rand = Math.random().toString(36).slice(2, 8);

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
    const bodyMd = typeof body.bodyMd === 'string' ? body.bodyMd : '';
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

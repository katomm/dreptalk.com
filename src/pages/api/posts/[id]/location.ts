import type { APIRoute } from 'astro';
import { getPostLocation } from '@/lib/db/forum';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';

export const prerender = false;

// Longest id this answers for. Post ids are UUIDs, the cap only keeps a
// pathological path segment away from the database.
const MAX_ID_LENGTH = 128;

/**
 * Where a post renders: the topic, the tab that shows posts there and the page.
 * Post links name only the post (/t/<slug>/#post-<id>), so a page that does
 * not hold the linked post asks here and moves to the right tab and page.
 *
 * Public data with no viewer check: a hidden post is answered too, since the
 * thread renders its placeholder under the same id for every viewer.
 */
export const GET: APIRoute = async ({ locals, params }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
  const postId = params.id ?? '';
  const location = postId && postId.length <= MAX_ID_LENGTH ? await getPostLocation(db, postId) : null;
  if (!location) {
    return jsonResponse({ ok: false, error: 'post_not_found' }, 404);
  }
  return jsonResponse({ ok: true, ...location }, 200, { 'Cache-Control': 'public, max-age=60' });
};

import type { APIRoute } from 'astro';
import { getPostLocation } from '@/lib/db/forum';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { isForumId } from '@/lib/validation/input';

export const prerender = false;

/**
 * Where a post renders: the topic, whether it is a governance action, the page.
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
  const location = isForumId(postId) ? await getPostLocation(db, postId) : null;
  if (!location) {
    return jsonResponse({ ok: false, error: 'post_not_found' }, 404);
  }
  return jsonResponse({ ok: true, ...location }, 200, { 'Cache-Control': 'public, max-age=60' });
};

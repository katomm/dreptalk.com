import type { APIRoute } from 'astro';
import { getPostHistory } from '@/lib/db/forum';
import { isModerator } from '@/lib/auth/roles';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
  const postId = params.id ?? '';
  if (!postId) {
    return jsonResponse({ ok: false, error: 'missing post id' }, 400);
  }

  const history = await getPostHistory(db, postId);
  if (!history) {
    return jsonResponse({ ok: false, error: 'post_not_found' }, 404);
  }

  // A community-hidden post's history is visible only to its author and moderators,
  // mirroring the post-body visibility gate (postViewerContext.canSeeContent).
  const user = (locals as App.Locals).user;
  if (history.hidden) {
    const isOwner = !!user && user.id === history.authorId;
    const isMod = !!user && isModerator(user.roles);
    if (!isOwner && !isMod) {
      return jsonResponse({ ok: false, error: 'post_not_found' }, 404);
    }
  }

  return jsonResponse(
    {
      ok: true,
      versions: history.versions,
      topicSlug: history.topicSlug,
      topicTitle: history.topicTitle,
    },
    200,
  );
};

import type { APIRoute } from 'astro';
import { handleDraftUnlink } from '@/lib/forum/handlers';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, params }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
  const topicId = params.id ?? '';
  if (!topicId) {
    return jsonResponse({ ok: false, error: 'missing topic id' }, 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON' }, 400);
  }

  const result = await handleDraftUnlink({
    user: locals.user,
    topicId,
    body: body as { actionId: unknown },
    db,
    rateLimiter,
    now: Date.now(),
  });
  return jsonResponse(result.json, result.status);
};

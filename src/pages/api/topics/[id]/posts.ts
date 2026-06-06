import type { APIRoute } from 'astro';
import { handleCreatePost } from '@/lib/forum/handlers';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, params }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const rateKv = env.NONCES as KVNamespace | undefined;

  if (!db || !rateKv) {
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

  const result = await handleCreatePost({
    user: locals.user,
    topicId,
    body: body as { bodyMd: unknown },
    db,
    rateKv,
    now: Date.now(),
  });

  return jsonResponse(result.json, result.status);
};

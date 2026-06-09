import type { APIRoute } from 'astro';
import { handleCreateTopic } from '@/lib/forum/handlers';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;

  if (!db || !rateLimiter) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON' }, 400);
  }

  const result = await handleCreateTopic({
    user: locals.user,
    body: body as { categorySlug: unknown; title: unknown; bodyMd: unknown },
    db,
    rateLimiter,
    now: Date.now(),
  });

  return jsonResponse(result.json, result.status);
};

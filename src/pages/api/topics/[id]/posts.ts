import type { APIRoute } from 'astro';
import { handleCreatePost } from '@/lib/forum/handlers';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, params }) => {
  const env = (locals as App.Locals).runtime?.env ?? {};
  const db = env.DB as D1Database | undefined;
  const rateKv = env.NONCES as KVNamespace | undefined;

  if (!db || !rateKv) {
    return new Response(JSON.stringify({ ok: false, error: 'service unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const topicId = params.id ?? '';
  if (!topicId) {
    return new Response(JSON.stringify({ ok: false, error: 'missing topic id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid JSON' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const result = await handleCreatePost({
    user: locals.user,
    topicId,
    body: body as { bodyMd: unknown },
    db,
    rateKv,
    now: Date.now(),
  });

  return new Response(JSON.stringify(result.json), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
};

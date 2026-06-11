import type { APIRoute } from 'astro';
import { handleReactToPost, handleClearReaction, type HandlerResult } from '@/lib/forum/handlers';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';

export const prerender = false;

/** Resolves the bindings both verbs need, or the error response to send. */
function resolveDeps(locals: App.Locals, postId: string) {
  const env = runtimeEnv(locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;

  if (!db || !rateLimiter) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
  if (!postId) {
    return jsonResponse({ ok: false, error: 'missing post id' }, 400);
  }
  return { db, rateLimiter };
}

function send(result: HandlerResult): Response {
  return jsonResponse(result.json, result.status);
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const deps = resolveDeps(locals as App.Locals, params.id ?? '');
  if (deps instanceof Response) return deps;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON' }, 400);
  }
  const reaction = (body as { reaction?: unknown } | null)?.reaction;

  return send(
    await handleReactToPost(
      { user: locals.user, postId: params.id ?? '', ...deps, now: Date.now() },
      reaction,
    ),
  );
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const deps = resolveDeps(locals as App.Locals, params.id ?? '');
  if (deps instanceof Response) return deps;

  return send(
    await handleClearReaction({ user: locals.user, postId: params.id ?? '', ...deps, now: Date.now() }),
  );
};

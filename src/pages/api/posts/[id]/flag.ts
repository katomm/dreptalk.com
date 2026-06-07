import type { APIRoute } from 'astro';
import { handleFlagPost, handleUnflagPost, type FlagPostInput } from '@/lib/forum/handlers';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';

export const prerender = false;

type FlagHandler = (input: FlagPostInput) => Promise<{ status: number; json: unknown }>;

/** Shared wiring for both verbs: resolves deps, runs the handler, always returns a Response. */
async function run(handler: FlagHandler, locals: App.Locals, postId: string): Promise<Response> {
  const env = runtimeEnv(locals);
  const db = env.DB as D1Database | undefined;
  const rateKv = env.NONCES as KVNamespace | undefined;

  if (!db || !rateKv) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
  if (!postId) {
    return jsonResponse({ ok: false, error: 'missing post id' }, 400);
  }

  const result = await handler({ user: locals.user, postId, db, rateKv, now: Date.now() });
  return jsonResponse(result.json, result.status);
}

export const POST: APIRoute = ({ locals, params }) =>
  run(handleFlagPost, locals as App.Locals, params.id ?? '');

export const DELETE: APIRoute = ({ locals, params }) =>
  run(handleUnflagPost, locals as App.Locals, params.id ?? '');

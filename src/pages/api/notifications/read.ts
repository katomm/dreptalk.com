import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { markAllRead } from '@/lib/db/notifications';

export const prerender = false;

// Marks all of the signed-in user's notifications read (personal rows and the
// broadcast cursor) and sends the browser back to the inbox. Plain form POST,
// no client JS.
export const POST: APIRoute = async ({ locals, redirect }) => {
  const user = locals.user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  const db = runtimeEnv(locals as App.Locals).DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
  await markAllRead(db, user.id, Date.now());
  return redirect('/notifications/', 303);
};

// POST /api/auth/logout-all: revokes every session for the signed-in user,
// including the caller's own. This is the lost-device recovery path (a paired
// device is a full session, so a lost or stolen one needs a way to be cut off).
//
// Like logout.ts this is a plain form POST with a 303 redirect, because the
// strict CSP forbids inline scripts.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { revokeAllForUser, clearSessionCookie } from '@/lib/auth/session';
import { isSameOriginRequest } from '@/lib/http/origin';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = (locals as App.Locals).user;
    // Nothing to revoke; redirecting home is accurate here, not misleading,
    // since there was no signed-in session to begin with.
    if (!user) return new Response(null, { status: 303, headers: { location: '/' } });
    if (!isSameOriginRequest(request)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

    const sessionKv = runtimeEnv(locals as App.Locals).SESSIONS as KVNamespace | undefined;
    if (!sessionKv) return jsonResponse({ ok: false, error: 'service unavailable' }, 503);

    // KV is eventually consistent, so a revoked session can briefly still
    // resolve at some edges; that limitation is called out in the help text,
    // not handled here.
    await revokeAllForUser(sessionKv, user.id);

    return new Response(null, {
      status: 303,
      headers: { location: '/', 'set-cookie': clearSessionCookie() },
    });
  } catch {
    // Unexpected error (e.g. a transient KV failure) partway through
    // revocation. Deliberately not a 303 to '/': that is the success shape,
    // and returning it here would tell the user they are signed out
    // everywhere when the revocation may not have completed and the session
    // cookie has not been cleared. A JSON error response keeps the browser on
    // this URL instead of quietly landing on the home page, so the failure is
    // visible rather than mistaken for success.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

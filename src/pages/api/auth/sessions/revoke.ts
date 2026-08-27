// POST /api/auth/sessions/revoke: signs one device out, from the device list on
// /devices. The narrow counterpart to logout-all: it takes a session id that
// listSessionsForUser handed to this very user, and revokeSessionForUser
// refuses ids belonging to anyone else.
//
// Like logout-all.ts this is a plain form POST with a 303 redirect, because the
// strict CSP forbids inline scripts.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import {
  revokeSessionForUser,
  parseSessionToken,
  clearSessionCookie,
  sessionIdForToken,
} from '@/lib/auth/session';
import { isSameOriginRequest } from '@/lib/http/origin';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = (locals as App.Locals).user;
    if (!user) return new Response(null, { status: 303, headers: { location: '/login/' } });
    if (!isSameOriginRequest(request)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

    const sessionKv = runtimeEnv(locals as App.Locals).SESSIONS as KVNamespace | undefined;
    if (!sessionKv) return jsonResponse({ ok: false, error: 'service unavailable' }, 503);

    const form = await request.formData();
    const sessionId = String(form.get('session_id') ?? '');
    const revoked = await revokeSessionForUser(sessionKv, user.id, sessionId);

    // Revoking the device you are sitting at is allowed (it is just a logout),
    // so clear the cookie in that case instead of leaving a dead one behind.
    const token = parseSessionToken(request.headers.get('Cookie'));
    const ownSession = revoked && token !== null && (await sessionIdForToken(token)) === sessionId;

    const headers: Record<string, string> = {
      location: ownSession ? '/' : `/devices/${revoked ? '?revoked=1' : '?revoked=0'}`,
    };
    if (ownSession) headers['set-cookie'] = clearSessionCookie();
    return new Response(null, { status: 303, headers });
  } catch {
    // Unexpected error (e.g. a transient KV failure). Not a 303: that is the
    // success shape, and it would claim the device was signed out when it may
    // still be live.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

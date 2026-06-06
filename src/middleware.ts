// Session middleware: reads the dreptalk_session cookie and sets locals.user.
import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { parseSessionToken, getSession } from './lib/auth/session.js';

export const onRequest = defineMiddleware(async (context, next) => {
  // Default to unauthenticated.
  context.locals.user = null;

  const sessionKv = env?.SESSIONS as KVNamespace | undefined;

  if (sessionKv) {
    const cookieHeader = context.request.headers.get('Cookie');
    const token = parseSessionToken(cookieHeader);
    if (token) {
      const record = await getSession(sessionKv, token);
      if (record) {
        context.locals.user = { id: record.userId, roles: record.roles };
      }
    }
  }

  return next();
});

// ---------------------------------------------------------------------------
// Access control helper for write-gated endpoints (Phase 3+).
// ---------------------------------------------------------------------------

export interface UnauthorizedMarker {
  type: 'unauthorized';
}

/**
 * Returns an UnauthorizedMarker when the request is unauthenticated.
 * Callers check the return value; if it is not null, they return a 401.
 *
 * Usage:
 *   const guard = requireWriter(Astro.locals);
 *   if (guard) return new Response('Unauthorized', { status: 401 });
 */
export function requireWriter(
  locals: App.Locals,
): UnauthorizedMarker | null {
  if (!locals.user) {
    return { type: 'unauthorized' };
  }
  return null;
}

// Session middleware: reads the dreptalk_session cookie and sets locals.user,
// and attaches the baseline security headers to every SSR response (public/_headers
// does not cover Worker-generated responses on Cloudflare Workers Static Assets).
import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { parseSessionToken, getSession } from './lib/auth/session.js';
import { applySecurityHeaders, relaxStyleSrc } from './lib/http/securityHeaders.js';
import { currentNetwork } from './lib/api/response.js';

export const onRequest = defineMiddleware(async (context, next) => {
  // Canonical host: permanently redirect www to the apex so clients and search
  // engines consolidate on https://dreptalk.com. Runs first to skip the session
  // KV read on the redirect. Other hosts (apex, workers.dev, localhost) fall
  // through untouched.
  const url = new URL(context.request.url);
  if (url.hostname === 'www.dreptalk.com') {
    url.hostname = 'dreptalk.com';
    return context.redirect(url.toString(), 301);
  }

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

  const response = await next();
  applySecurityHeaders(response.headers);
  relaxStyleSrc(response.headers);
  // Keep the preprod mirror (preprod.dreptalk.com) out of search indexes so it
  // never competes with mainnet or surfaces test data. currentNetwork() is the
  // single source of truth for the active network (and fails closed on an
  // unknown CARDANO_NETWORK value).
  if (currentNetwork().network === 'preprod') {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return response;
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

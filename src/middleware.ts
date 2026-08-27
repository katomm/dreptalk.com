// Session middleware: reads the dreptalk_session cookie and sets locals.user,
// and attaches the baseline security headers to every SSR response (public/_headers
// does not cover Worker-generated responses on Cloudflare Workers Static Assets).
import { defineMiddleware } from 'astro:middleware';
import { env, waitUntil } from 'cloudflare:workers';
import { parseSessionToken, getSession, buildSessionCookie, clearSessionCookie } from './lib/auth/session.js';
import { sessionActivityHook } from './lib/auth/sessionActivity.js';
import { crossOriginWriteResponse } from './lib/http/origin.js';
import { applySecurityHeaders, relaxStyleSrc } from './lib/http/securityHeaders.js';
import { isDatabaseUnavailable, serviceUnavailableResponse } from './lib/http/serviceUnavailable.js';
import { pageCacheKey, isCacheableRequest, isCacheableResponse } from './lib/http/pageCache.js';
import { currentNetwork } from './lib/api/response.js';
import { buildServiceDescription } from './lib/cip100/service.js';
import { originForNetwork } from './lib/cip100/origin.js';
import { corsHeaders } from './lib/cip100/cors.js';

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

  // RFC 8615 service description for the CIP-100 documents. Served here rather
  // than as a page, because a dot-directory under src/pages is not a reliable
  // route path. No session read and no cache lookup needed for it.
  if (url.pathname === '/.well-known/cip-100.json') {
    const network = currentNetwork().network === 'preprod' ? 'preprod' : 'mainnet';
    const res = new Response(buildServiceDescription(originForNetwork(network), network), {
      status: 200,
      headers: corsHeaders({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      }),
    });
    applySecurityHeaders(res.headers);
    return res;
  }

  // Cross-origin browser writes are rejected site-wide before any work
  // happens; see crossOriginWriteResponse for the semantics.
  const originBlock = crossOriginWriteResponse(context.request);
  if (originBlock) {
    applySecurityHeaders(originBlock.headers);
    return originBlock;
  }

  // Anonymous page cache. A logged-out GET to a page that declares itself public
  // is served from (and later stored in) the edge cache, so repeat anonymous
  // traffic skips the session read, the render, and its D1 queries. Disabled in
  // dev so a page edit is never masked by a stale cached copy. Any request with a
  // session cookie stays fully dynamic and never touches the cache. The stored
  // response already carries the security headers (put happens after they are
  // applied), so a hit is returned verbatim. See lib/http/pageCache for the rules.
  const cacheKey =
    !import.meta.env.DEV && isCacheableRequest(context.request)
      ? pageCacheKey(context.request.url)
      : null;
  const cache = cacheKey ? (caches as CacheStorage & { default: Cache }).default : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey);
    // A Cache API response has immutable headers; hand back a fresh, mutable copy.
    if (hit) return new Response(hit.body, hit);
  }

  // Default to unauthenticated.
  context.locals.user = null;

  const sessionKv = env?.SESSIONS as KVNamespace | undefined;

  // What to do with the session cookie after the render: leave it alone, slide
  // it forward, or clear a dead one. Resolved into a Set-Cookie below.
  let cookieAction: 'none' | 'slide' | 'clear' = 'none';
  let sessionToken: string | null = null;

  if (sessionKv) {
    const cookieHeader = context.request.headers.get('Cookie');
    const token = parseSessionToken(cookieHeader);
    if (token) {
      const db = env?.DB as D1Database | undefined;
      // The record slides server-side every 6 hours, but the cookie carries a
      // fixed Max-Age from the mint. Without re-issuing it here an active user
      // is signed out exactly 30 days after signing in. onSlide fires on the
      // same 6-hour cadence, so this costs one extra header twice a day.
      sessionToken = token;
      const record = await getSession(sessionKv, token, {
        onRenew: db ? sessionActivityHook(db) : undefined,
        onSlide: () => {
          cookieAction = 'slide';
        },
      });
      if (record) {
        context.locals.user = {
          id: record.userId,
          roles: record.roles,
          drepId: record.drepId,
          grantId: record.grantId ?? null,
          actsFor: record.actsFor ?? null,
        };
      } else {
        // Expired, revoked, or past the absolute lifetime cap: drop the dead
        // cookie so the browser stops sending it for the next 30 days.
        cookieAction = 'clear';
      }
    }
  }

  // Render the page. If it throws because D1 is briefly unavailable (a
  // Cloudflare-side storage hiccup, not our bug), serve a friendly 503 page
  // instead of a blank 500. Any other error keeps its normal 500 so it stays
  // visible. The shared post-processing below still runs on the 503.
  let response: Response;
  try {
    response = await next();
  } catch (err) {
    if (!isDatabaseUnavailable(err)) throw err;
    console.error('Serving 503 (database temporarily unavailable):', err);
    response = serviceUnavailableResponse(url.pathname);
  }

  applySecurityHeaders(response.headers);
  relaxStyleSrc(response.headers);
  // Never overwrite a cookie the route set itself: logout clears the session
  // cookie in its own response, and re-issuing it here would undo the logout.
  if (cookieAction !== 'none' && !response.headers.has('set-cookie')) {
    response.headers.append(
      'set-cookie',
      cookieAction === 'clear' || sessionToken === null
        ? clearSessionCookie()
        : buildSessionCookie(sessionToken, { secure: url.protocol === 'https:' }),
    );
  }
  // Keep the preprod mirror (preprod.dreptalk.com) out of search indexes so it
  // never competes with mainnet or surfaces test data. currentNetwork() is the
  // single source of truth for the active network (and fails closed on an
  // unknown CARDANO_NETWORK value).
  if (currentNetwork().network === 'preprod') {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  // Store an anonymous, public HTML render for the next visitor. Runs after the
  // header post-processing above so the cached copy is byte-complete; the put is
  // deferred so the miss that paid for the render does not wait on the write.
  if (cache && cacheKey && isCacheableResponse(response, context.locals.user)) {
    waitUntil(cache.put(cacheKey, response.clone()));
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

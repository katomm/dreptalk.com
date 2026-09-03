// Session middleware: reads the dreptalk_session cookie and sets locals.user,
// and attaches the baseline security headers to every SSR response (public/_headers
// does not cover Worker-generated responses on Cloudflare Workers Static Assets).
import { defineMiddleware } from 'astro:middleware';
import { env, waitUntil } from 'cloudflare:workers';
import { parseSessionToken, getSession, buildSessionCookie, clearSessionCookie } from './lib/auth/session.js';
import { sessionActivityHook } from './lib/auth/sessionActivity.js';
import { crossOriginWriteResponse } from './lib/http/origin.js';
import { applySecurityHeaders, relaxStyleSrc } from './lib/http/securityHeaders.js';
import { internalErrorResponse, isDatabaseUnavailable, serviceUnavailableResponse } from './lib/http/serviceUnavailable.js';
import {
  pageCacheKey,
  isCacheableRequest,
  isCacheableResponse,
  toStoredResponse,
  fromStoredResponse,
  isStale,
} from './lib/http/pageCache.js';
import { currentNetwork } from './lib/api/response.js';
import { buildServiceDescription } from './lib/cip100/service.js';
import { originForNetwork } from './lib/cip100/origin.js';
import { corsHeaders } from './lib/cip100/cors.js';

// The id of the deploy serving this request, for the page cache key. Provided by
// the version_metadata binding, which Cloudflare gives a fresh id on every
// deploy. Absent in dev and in tests, where the page cache is off anyway, so an
// undefined value simply leaves the key unversioned.
function deployVersion(): string | undefined {
  return (env as { CF_VERSION_METADATA?: { id?: string } })?.CF_VERSION_METADATA?.id;
}

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
  // traffic skips the render and its D1 queries. Disabled in dev so a page edit
  // is never masked by a stale cached copy. Any request with a session cookie
  // stays fully dynamic and never touches the cache. The lookup itself happens
  // below, once the render helper exists; a cacheable request carries no session
  // cookie by definition, so the session block in between costs it one header
  // parse and nothing else. See lib/http/pageCache for the rules.
  const cacheKey =
    !import.meta.env.DEV && isCacheableRequest(context.request)
      ? pageCacheKey(context.request.url, deployVersion())
      : null;
  const cache = cacheKey ? (caches as CacheStorage & { default: Cache }).default : null;

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

  // Renders the page and applies every response-shaping step, so a background
  // refresh produces byte for byte what a cache miss would have produced. If the
  // render throws because D1 is briefly unavailable (a Cloudflare-side storage
  // hiccup, not our bug), it serves a friendly 503 page. Any other error keeps
  // its 500 status, so it stays visible in logs and error rates, but gets a
  // friendly page instead of a blank response.
  const renderPage = async (): Promise<Response> => {
    let response: Response;
    try {
      response = await next();
    } catch (err) {
      if (isDatabaseUnavailable(err)) {
        console.error('Serving 503 (database temporarily unavailable):', err);
        response = serviceUnavailableResponse(url.pathname);
      } else {
        console.error(`Serving 500 for ${url.pathname}:`, err);
        response = internalErrorResponse(url.pathname);
      }
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
    return response;
  };

  if (cache && cacheKey) {
    /** Stores a render for the next visitor, if it is one anonymous visitors may share. */
    const storePage = async (page: Response): Promise<void> => {
      if (isCacheableResponse(page, context.locals.user)) {
        await cache.put(cacheKey, toStoredResponse(page, Date.now()));
      }
    };

    const hit = await cache.match(cacheKey);
    if (hit) {
      const stale = isStale(hit, Date.now());
      // A Cache API response has immutable headers; hand back a fresh, mutable
      // copy carrying the page's own Cache-Control rather than the storage TTL.
      const served = fromStoredResponse(hit);
      // Past its declared freshness the copy still goes out immediately, and the
      // re-render runs behind it so the next visitor gets the fresh one. Nobody
      // waits on a render, and a failed refresh just leaves the entry to expire.
      if (stale) waitUntil(renderPage().then(storePage));
      // Says which of the three paths served this response, so cache behaviour
      // can be checked from outside with a single request. Carries no user or
      // request detail, only which branch ran.
      served.headers.set('X-Page-Cache', stale ? 'stale' : 'hit');
      return served;
    }

    const response = await renderPage();
    // Clone only what is going to be stored: an unread clone of a response
    // nobody caches keeps the whole body buffered for nothing. The put itself
    // is deferred so the miss that paid for the render does not wait on it.
    if (isCacheableResponse(response, context.locals.user)) {
      waitUntil(storePage(response.clone()));
    }
    response.headers.set('X-Page-Cache', 'miss');
    return response;
  }

  return renderPage();
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

// Anonymous page cache: brief edge caching for logged-out visitors. SSR pages
// already declare their own Cache-Control (public + an s-maxage, via
// cacheControlFor / cacheControlForSynced), which is the opt-in signal; an
// authenticated render carries user-specific header chrome and is never cached.
// These are the pure predicates; the middleware wires them to caches.default.
// On this Cloudflare zone s-maxage alone does not edge-cache a Worker response,
// only the Cache API does, so the header is otherwise inert for logged-out traffic.
import { parseSessionToken } from '../auth/session.js';

/**
 * Cache key for a page: the URL plus the deploy it was rendered by, GET. Never
 * keyed on cookies or other request headers, so every anonymous visitor on one
 * deploy shares a single entry per URL.
 *
 * The deploy id is in the key because a stored page names hashed asset bundles,
 * and a deploy replaces the asset manifest wholesale, so the bundles an earlier
 * render points at stop existing. Without it, an entry written just before a
 * deploy keeps being served afterwards for the rest of its TTL, and the page
 * arrives with no stylesheet at all. Changing the key makes a deploy miss every
 * older entry instead, and the strays age out on their own.
 *
 * The version is carried as a query parameter on the key. The key is only ever
 * matched against, never fetched, so the parameter reaches no origin and no log.
 * An absent version degrades to the old URL-only behaviour rather than throwing.
 */
export function pageCacheKey(url: string, version?: string): Request {
  if (!version) return new Request(url, { method: 'GET' });
  const keyed = new URL(url);
  keyed.searchParams.set('__deploy', version);
  return new Request(keyed.toString(), { method: 'GET' });
}

/**
 * A request eligible to read or write the anon cache: a GET carrying no session
 * cookie at all, so it is unambiguously anonymous. A visitor with any session
 * cookie (even an expired one) bypasses, keeping their render private and never
 * populating the shared cache.
 */
export function isCacheableRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;
  return parseSessionToken(request.headers.get('Cookie')) === null;
}

/**
 * A response safe to store for anonymous visitors: never an authenticated render,
 * only a cookie-free HTML 200 that opts in through its own Cache-Control (public,
 * without no-store/private) and names the freshness it wants. The page's s-maxage
 * sets the edge TTL, so a response that declares none has nothing to store under.
 */
export function isCacheableResponse(response: Response, user: unknown | null): boolean {
  if (user) return false;
  if (response.status !== 200) return false;
  if (response.headers.has('Set-Cookie')) return false;
  if (!(response.headers.get('Content-Type') ?? '').includes('text/html')) return false;
  const cacheControl = response.headers.get('Cache-Control') ?? '';
  if (/\b(?:no-store|private)\b/.test(cacheControl)) return false;
  if (sMaxAge(cacheControl) === null) return false;
  return /\bpublic\b/.test(cacheControl);
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate
// ---------------------------------------------------------------------------
// A page's own s-maxage says how fresh a visitor's copy should be, and until now
// it was also how long the entry survived: past it the entry was gone and the
// next visitor paid the full render. On a site whose traffic per colo is thinner
// than that window, that meant most visitors paid it.
//
// So the stored copy keeps a longer TTL than the page asks for, and a hit older
// than the page's own s-maxage is still served, with a refresh kicked off behind
// it. Whoever arrives next gets the fresh copy. The visitor never waits on a
// render, and the only cost is that a page nobody has requested in a while can
// be up to the stored TTL old, which is exactly the case where nobody was
// looking anyway.

/** Header carrying the render time (unix ms) on the stored copy. */
export const PAGE_CACHE_STAMP = 'x-page-cache-stamp';
/** Header parking the page's own Cache-Control while the stored copy carries a longer one. */
export const PAGE_CACHE_CC = 'x-page-cache-cc';
/** How much longer than its own s-maxage an entry is kept, to be served stale. */
const STALE_FACTOR = 10;
/** Ceiling on how far PAST its declared freshness an entry may still be served. */
const MAX_STALE_SECONDS = 600;

/** The s-maxage in a Cache-Control value, or null when it declares none. */
export function sMaxAge(cacheControl: string | null): number | null {
  const m = /\bs-maxage=(\d+)/.exec(cacheControl ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * How long the stored copy should live: ten times the freshness its page asked
 * for, but never more than MAX_STALE_SECONDS past it. Expressed as a ceiling on
 * the STALENESS rather than on the TTL, so a page that declares a long freshness
 * (the legal pages and the treasury ask for an hour) still gets at least the
 * lifetime it asked for. Capping the TTL itself would have stored those pages
 * for LESS time than before, and left them no stale window at all.
 */
export function storedTtlSeconds(freshSeconds: number): number {
  return Math.min(freshSeconds * STALE_FACTOR, freshSeconds + MAX_STALE_SECONDS);
}

/**
 * The copy to hand to the cache: the page's own Cache-Control parked in a header
 * and replaced by the longer storage TTL, plus the render time. Only ever called
 * for a response isCacheableResponse accepted, which is what guarantees the
 * s-maxage this reads.
 */
export function toStoredResponse(response: Response, nowMs: number): Response {
  const own = response.headers.get('Cache-Control') ?? '';
  const stored = new Response(response.body, response);
  stored.headers.set(PAGE_CACHE_CC, own);
  stored.headers.set(PAGE_CACHE_STAMP, String(nowMs));
  stored.headers.set('Cache-Control', `public, s-maxage=${storedTtlSeconds(sMaxAge(own) ?? 0)}`);
  return stored;
}

/**
 * The copy to hand to the visitor: the page's own Cache-Control restored and the
 * bookkeeping headers stripped, so a cached render is indistinguishable from a
 * fresh one.
 */
export function fromStoredResponse(hit: Response): Response {
  const served = new Response(hit.body, hit);
  const own = served.headers.get(PAGE_CACHE_CC);
  if (own) served.headers.set('Cache-Control', own);
  served.headers.delete(PAGE_CACHE_CC);
  served.headers.delete(PAGE_CACHE_STAMP);
  return served;
}

/**
 * Whether a hit has outlived the freshness its page asked for and should be
 * refreshed behind the visitor's back. The two markers are written together, so
 * an entry missing either was not written by this code (an older deploy's
 * format, say) and is refreshed on sight.
 */
export function isStale(hit: Response, nowMs: number): boolean {
  const fresh = sMaxAge(hit.headers.get(PAGE_CACHE_CC));
  const stamped = Number(hit.headers.get(PAGE_CACHE_STAMP));
  if (fresh === null || !(stamped > 0)) return true;
  return nowMs - stamped >= fresh * 1000;
}

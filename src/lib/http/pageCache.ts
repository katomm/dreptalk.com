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
 * without no-store/private). The page's s-maxage sets the edge TTL.
 */
export function isCacheableResponse(response: Response, user: unknown | null): boolean {
  if (user) return false;
  if (response.status !== 200) return false;
  if (response.headers.has('Set-Cookie')) return false;
  if (!(response.headers.get('Content-Type') ?? '').includes('text/html')) return false;
  const cacheControl = response.headers.get('Cache-Control') ?? '';
  if (/\b(?:no-store|private)\b/.test(cacheControl)) return false;
  return /\bpublic\b/.test(cacheControl);
}

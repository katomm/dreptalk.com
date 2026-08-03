// Anonymous page cache: brief edge caching for logged-out visitors. SSR pages
// already declare their own Cache-Control (public + an s-maxage, via
// cacheControlFor / cacheControlForSynced), which is the opt-in signal; an
// authenticated render carries user-specific header chrome and is never cached.
// These are the pure predicates; the middleware wires them to caches.default.
// On this Cloudflare zone s-maxage alone does not edge-cache a Worker response,
// only the Cache API does, so the header is otherwise inert for logged-out traffic.
import { parseSessionToken } from '../auth/session.js';

/**
 * Cache key for a page: the URL only, GET. Never keyed on cookies or other request
 * headers, so every anonymous visitor shares one entry per URL.
 */
export function pageCacheKey(url: string): Request {
  return new Request(url, { method: 'GET' });
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

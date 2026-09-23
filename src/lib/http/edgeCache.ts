// Colo edge cache for Worker responses (avatars, public JSON APIs). A colo warm
// hit skips the Worker's work entirely. Without it the response is only
// browser-cached, so every uncached visitor pays the storage or D1 round-trip.
import { waitUntil } from 'cloudflare:workers';

/**
 * Serves `request` from the colo cache, or from `produce` on a miss. Only a 200
 * is stored, so a miss (404) or a redirect can resolve differently later. The
 * put runs after the response is sent, so a miss never pays for it. `keyPath`
 * (path plus query, on the request's origin) replaces the request URL as the
 * cache key, for routes that normalize the key (drop the query string, fold
 * case) so a varied URL cannot bypass the cache.
 */
export async function withEdgeCache(
  request: Request,
  produce: () => Promise<Response>,
  keyPath?: string,
): Promise<Response> {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(keyPath ? new URL(keyPath, request.url) : request.url, {
    method: 'GET',
  });
  const cached = await cache.match(cacheKey);
  // Return a fresh, mutable copy: the security middleware decorates every
  // response with headers, and a Cache API Response carries immutable headers.
  if (cached) return new Response(cached.body, cached);

  const response = await produce();
  if (response.status === 200) waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

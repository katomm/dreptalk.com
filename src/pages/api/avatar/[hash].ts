// GET /api/avatar/:hash
//
// Serves a self-hosted DRep avatar from R2, content addressed by the sha256 of
// its bytes (written by the gov-sync avatar store pass). No upstream fetch
// happens at request time: visitors never touch the third-party image host.
import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { serveAvatar } from '@/lib/dreps/avatarServe';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);

  // The URL is content addressed (immutable bytes per hash), so it is a perfect
  // edge-cache key: a colo warm hit skips the Worker's R2 read entirely. Without
  // this the response is only browser-cached, so every uncached visitor pays the
  // R2 round-trip, which shows up in the avatar's LCP tail on profile pages.
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  // Return a fresh, mutable copy: the security middleware decorates every
  // response with headers, and a Cache API Response carries immutable headers
  // (see the same handling in api/search.ts).
  if (cached) return new Response(cached.body, cached);

  const response = await serveAvatar(env.AVATARS as R2Bucket | undefined, params.hash);
  // Only cache the immutable hit; misses (404) stay uncached so a later store
  // pass can serve the object once it exists. The put runs after the response
  // is sent, so a miss never pays for it.
  if (response.status === 200) waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

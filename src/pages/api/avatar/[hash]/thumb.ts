// GET /api/avatar/:hash/thumb
//
// Small rendition of a self-hosted avatar for list-size placements (see
// avatarUrl). Same content addressing and edge caching as /api/avatar/:hash.
import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { serveAvatarThumb } from '@/lib/dreps/avatarServe';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);

  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  // Fresh, mutable copy: the security middleware decorates response headers.
  if (cached) return new Response(cached.body, cached);

  const response = await serveAvatarThumb(env.AVATARS as R2Bucket | undefined, env.IMAGES, params.hash, waitUntil);
  if (response.status === 200) waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

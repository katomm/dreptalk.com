import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { handleSearch, normalizeQuery } from '@/lib/search/handler';

export const prerender = false;

// Identical queries are cached at the edge briefly. The key is the normalized,
// lowercased query: FTS5 unicode61 is case-insensitive, so folding case is
// loss-free and improves the hit rate. All search data is public.
const CACHE_TTL_SECONDS = 60;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ query: '', exact: null, governanceActions: [], discussions: [], dreps: [] }, 503);
  }

  const url = new URL(request.url);
  const q = normalizeQuery(url.searchParams.get('q')).toLowerCase();

  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(`${url.origin}/api/search?q=${encodeURIComponent(q)}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const body = await handleSearch(db, q);
  const response = jsonResponse(body, 200, {
    'Cache-Control': `public, max-age=30, s-maxage=${CACHE_TTL_SECONDS}`,
  });
  // Cache write happens after the response is sent; a miss must not pay for the put.
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

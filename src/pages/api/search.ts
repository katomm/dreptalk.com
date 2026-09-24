import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { handleSearch, normalizeQuery } from '@/lib/search/handler';
import { getContentIndex } from '@/lib/search/contentIndex';
import { parseScope } from '@/lib/search/scopes';
import { parsePage } from '@/lib/forum/view';

export const prerender = false;

// Identical queries are cached at the edge briefly. The key is the normalized,
// lowercased query plus scope/page/counts: FTS5 unicode61 is case-insensitive,
// so folding case is loss-free and improves the hit rate. All search data is public.
const CACHE_TTL_SECONDS = 60;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  // Without a D1 binding the help and Governance Review groups still answer.
  const db = env.DB as D1Database | undefined;

  const url = new URL(request.url);
  const q = normalizeQuery(url.searchParams.get('q')).toLowerCase();
  const scope = parseScope(url.searchParams.get('scope'));
  const page = parsePage(url.searchParams.get('page'));
  const counts = url.searchParams.get('counts') === '1';

  const cache = (caches as CacheStorage & { default: Cache }).default;
  const keyUrl = `${url.origin}/api/search?q=${encodeURIComponent(q)}&scope=${scope}&page=${page}&counts=${counts ? 1 : 0}`;
  const cacheKey = new Request(keyUrl, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  // A Response from the Cache API carries immutable headers. The security
  // middleware sets headers on every response, so returning the cached Response
  // directly throws "Can't modify immutable headers" and the client sees the
  // search fail. Return a fresh, mutable copy so the middleware can decorate it.
  if (cached) return new Response(cached.body, cached);

  const body = await handleSearch(db, q, { scope, page, counts, content: await getContentIndex() });
  const response = jsonResponse(body, 200, {
    'Cache-Control': `public, max-age=30, s-maxage=${CACHE_TTL_SECONDS}`,
  });
  // Cache write happens after the response is sent; a miss must not pay for the put.
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

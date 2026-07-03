import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { handleSearch, normalizeQuery } from '@/lib/search/handler';
import { parseApiScope } from '@/lib/search/scopes';
import { parsePage } from '@/lib/forum/view';

export const prerender = false;

// Identical queries are cached at the edge briefly. The key is the normalized,
// lowercased query plus scope/page/counts: FTS5 unicode61 is case-insensitive,
// so folding case is loss-free and improves the hit rate. All search data is public.
const CACHE_TTL_SECONDS = 60;

const EMPTY_503 = {
  query: '',
  scope: 'all' as const,
  page: 1,
  exact: null,
  governanceActions: [],
  discussions: [],
  dreps: [],
  total: null,
  counts: null,
};

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) {
    return jsonResponse(EMPTY_503, 503);
  }

  const url = new URL(request.url);
  const q = normalizeQuery(url.searchParams.get('q')).toLowerCase();
  const scope = parseApiScope(url.searchParams.get('scope'));
  const page = parsePage(url.searchParams.get('page'));
  const counts = url.searchParams.get('counts') === '1';

  const cache = (caches as CacheStorage & { default: Cache }).default;
  const keyUrl = `${url.origin}/api/search?q=${encodeURIComponent(q)}&scope=${scope}&page=${page}&counts=${counts ? 1 : 0}`;
  const cacheKey = new Request(keyUrl, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const body = await handleSearch(db, q, { scope, page, counts });
  const response = jsonResponse(body, 200, {
    'Cache-Control': `public, max-age=30, s-maxage=${CACHE_TTL_SECONDS}`,
  });
  // Cache write happens after the response is sent; a miss must not pay for the put.
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

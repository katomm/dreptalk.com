import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { withEdgeCache } from '@/lib/http/edgeCache';
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

  return withEdgeCache(
    request,
    async () => {
      const body = await handleSearch(db, q, {
        scope,
        page,
        counts,
        content: await getContentIndex(),
      });
      return jsonResponse(body, 200, {
        'Cache-Control': `public, max-age=30, s-maxage=${CACHE_TTL_SECONDS}`,
      });
    },
    `/api/search?q=${encodeURIComponent(q)}&scope=${scope}&page=${page}&counts=${counts ? 1 : 0}`,
  );
};

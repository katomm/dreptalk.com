import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { withEdgeCache } from '@/lib/http/edgeCache';
import { listMentionCandidates } from '@/lib/db/mentionCandidates';

export const prerender = false;

// The candidate set only changes when gov-sync assigns slugs (hourly), so a
// long edge TTL is safe, slight staleness is harmless for autocomplete.
const CACHE_TTL_SECONDS = 3600;

export const GET: APIRoute = async ({ request, locals }) => {
  const db = runtimeEnv(locals as App.Locals).DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ candidates: [] }, 503);
  }

  return withEdgeCache(
    request,
    async () =>
      jsonResponse({ candidates: await listMentionCandidates(db) }, 200, {
        'Cache-Control': `public, max-age=300, s-maxage=${CACHE_TTL_SECONDS}`,
      }),
    '/api/mention-candidates',
  );
};

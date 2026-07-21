import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
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

  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(`${new URL(request.url).origin}/api/mention-candidates`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  // Cached responses carry immutable headers, the security middleware must be
  // able to decorate them, so return a fresh, mutable copy.
  if (cached) return new Response(cached.body, cached);

  const candidates = await listMentionCandidates(db);
  const response = jsonResponse({ candidates }, 200, {
    'Cache-Control': `public, max-age=300, s-maxage=${CACHE_TTL_SECONDS}`,
  });
  // Cache write happens after the response is sent, a miss must not pay for the put.
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

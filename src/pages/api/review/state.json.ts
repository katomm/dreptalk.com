// GET /api/review/state.json. Public, read-only, cached one hour through
// caches.default (the HTML page cache rejects JSON on purpose).
import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { jsonResponse, runtimeEnv, currentNetwork } from '@/lib/api/response';
import { buildReviewState } from '@/lib/review/state';
import { buildEditionIndex } from '@/lib/review/windows';

export const prerender = false;
const TTL = 3600;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'unavailable' }, 503);
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const key = new Request(`${new URL(request.url).origin}/api/review/state.json`, { method: 'GET' });
  const hit = await cache.match(key);
  // A Response from the Cache API carries immutable headers; return a fresh,
  // mutable copy so downstream middleware can still decorate it.
  if (hit) return new Response(hit.body, hit);

  const editions = await getCollection('review');
  const index = buildEditionIndex(
    editions.map((e) => ({
      from: e.data.epochFrom,
      to: e.data.epochTo,
      featured: e.data.featuredActions,
      rows: [...e.data.alsoDecided, ...e.data.openActions].map((r) => r.id),
    })),
  );
  const body = await buildReviewState(db, currentNetwork(), { lastCoveredEpoch: index.lastCoveredEpoch, nowMs: Date.now() });
  const res = jsonResponse(body, 200, { 'Cache-Control': `public, max-age=60, s-maxage=${TTL}` });
  waitUntil(cache.put(key, res.clone()));
  return res;
};

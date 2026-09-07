// GET /api/review/state.json. Public, read-only, cached one hour through
// caches.default (the HTML page cache rejects JSON on purpose).
import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv, currentNetwork } from '@/lib/api/response';
import { buildReviewState } from '@/lib/review/state';
import { loadEditionIndex } from '@/lib/review/editions';
import { isMainnet } from '@/lib/review/units';

export const prerender = false;
const TTL = 3600;

export const GET: APIRoute = async ({ request, locals }) => {
  const cfg = currentNetwork();
  // Mainnet only: editions carry mainnet facts and ship with every deployment,
  // so a preprod worker must not answer with its own numbers. Checked before
  // any database read.
  if (!isMainnet(cfg)) return jsonResponse({ error: 'governance review is mainnet only' }, 404);
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'unavailable' }, 503);
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const key = new Request(`${new URL(request.url).origin}/api/review/state.json`, { method: 'GET' });
  const hit = await cache.match(key);
  // A Response from the Cache API carries immutable headers, so return a fresh,
  // mutable copy that downstream middleware can still decorate.
  if (hit) return new Response(hit.body, hit);

  const index = await loadEditionIndex();
  const body = await buildReviewState(db, cfg, { lastCoveredEpoch: index.lastCoveredEpoch, nowMs: Date.now() });
  const res = jsonResponse(body, 200, { 'Cache-Control': `public, max-age=60, s-maxage=${TTL}` });
  waitUntil(cache.put(key, res.clone()));
  return res;
};

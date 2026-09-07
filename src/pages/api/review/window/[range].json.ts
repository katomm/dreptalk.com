// GET /api/review/window/650-652.json. The full data pack for one closed
// window of epochs, public and read-only, cached one hour through
// caches.default (the HTML page cache rejects JSON on purpose). The range is
// validated before any binding is touched, so a malformed or still-running
// window costs no database read.
import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv, currentNetwork } from '@/lib/api/response';
import { epochFromUnix } from '@/lib/config/network';
import { buildWindowPack } from '@/lib/review/pack';
import { EPOCH_STATS_SERIES_FLOOR, isMainnet } from '@/lib/review/units';

export const prerender = false;
const TTL = 3600;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const cfg = currentNetwork();
  // Mainnet only: editions carry mainnet facts and ship with every deployment,
  // so a preprod worker must not answer with its own numbers. Checked before
  // any database read.
  if (!isMainnet(cfg)) return jsonResponse({ error: 'governance review is mainnet only' }, 404);
  const m = /^(\d+)-(\d+)$/.exec(params.range ?? '');
  if (!m) return jsonResponse({ error: 'range must be from-to' }, 400);
  const from = Number(m[1]);
  const to = Number(m[2]);
  const current = epochFromUnix(Math.floor(Date.now() / 1000), cfg);
  if (to - from < 2 || to - from > 5 || to >= current) {
    return jsonResponse({ error: 'window must cover 3 to 6 closed epochs' }, 400);
  }
  // Below the first epoch the stats series exists for there is nothing to pack,
  // and the reads would scan the vote tables for a window that can never carry
  // an edition. Rejected here, before any binding is touched.
  const floor = EPOCH_STATS_SERIES_FLOOR[cfg.network];
  if (floor != null && from < floor) {
    return jsonResponse({ error: `window must start at epoch ${floor} or later` }, 400);
  }
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'unavailable' }, 503);
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const key = new Request(`${new URL(request.url).origin}/api/review/window/${from}-${to}.json`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);
  const body = await buildWindowPack(db, cfg, from, to);
  const res = jsonResponse(body, 200, { 'Cache-Control': `public, max-age=60, s-maxage=${TTL}` });
  waitUntil(cache.put(key, res.clone()));
  return res;
};

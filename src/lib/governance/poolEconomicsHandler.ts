/// <reference types="@cloudflare/workers-types" />
// GET /api/gov-action/pool-economics: the pool distribution of the current
// epoch for the parameter change impact panels. Active stake moves once per
// epoch, so the answer is cached per network and epoch for one epoch length.
// The epoch comes from the clock, never from the client. Data is labelled
// with the epoch of the totals it was read with and cached only when that
// matches the clock, so a lagging upstream at an epoch boundary is retried on
// the next request instead of being pinned for a whole epoch.
import { EPOCH_LENGTH_SECONDS, epochFromUnix, type NetworkConfig } from '@/lib/config/network.js';
import { currentNetwork, jsonResponse } from '@/lib/api/response.js';
import { gateGovActionRequest, GOV_ACTION_RATE_POLICIES } from './govActionGate.js';
import { govActionSubmissionAvailable, govActionTypeAvailable } from './submissionGate.js';
import { readPoolEconomics, type PoolEconomicsKoios } from './poolEconomics.js';

export interface PoolEconomicsDeps {
  koios: PoolEconomicsKoios;
  network?: NetworkConfig;
  env?: Cloudflare.Env;
  /** Injectable for tests, defaults to caches.default. */
  cache?: Cache;
  /** Injectable for tests, defaults to Date.now. */
  now?: () => number;
}

const NO_STORE = { 'cache-control': 'no-store' };

export async function handlePoolEconomics(
  ctx: { request: Request; locals: App.Locals },
  deps: PoolEconomicsDeps,
): Promise<Response> {
  const net = deps.network ?? currentNetwork();
  const availability = { submissionAvailable: govActionSubmissionAvailable(net.network), network: net.network };
  if (!govActionTypeAvailable('ParameterChange', availability)) return new Response('Not found', { status: 404 });
  const gate = await gateGovActionRequest(ctx, GOV_ACTION_RATE_POLICIES.economics, { network: net, env: deps.env });
  if (gate instanceof Response) return gate;
  const cache = deps.cache ?? (caches as CacheStorage & { default: Cache }).default;
  const epoch = epochFromUnix(Math.floor((deps.now ?? Date.now)() / 1000), net);
  const key = new Request(new URL(`/api/gov-action/pool-economics/cache/${net.network}/${epoch}`, ctx.request.url));
  try {
    const hit = await cache.match(key);
    // The cached body is already the JSON answer, so it is passed through as is.
    if (hit) return new Response(hit.body, { status: 200, headers: { 'content-type': 'application/json', ...NO_STORE } });
    const data = await readPoolEconomics(deps.koios);
    if (!data) return jsonResponse({ error: 'pool_data_unavailable' }, 503, NO_STORE);
    if (data.epoch === epoch) {
      await cache.put(key, new Response(JSON.stringify(data), { headers: { 'cache-control': `max-age=${EPOCH_LENGTH_SECONDS}` } }));
    }
    return jsonResponse(data, 200, NO_STORE);
  } catch (err: unknown) {
    console.error('[gov-action] pool-economics: read failed', err);
    return jsonResponse({ error: 'pool_data_unavailable' }, 503, NO_STORE);
  }
}

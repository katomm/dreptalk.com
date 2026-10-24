/// <reference types="@cloudflare/workers-types" />
// The pool distribution for the parameter change impact panels. The gov-sync
// cron computes it once per epoch and stores one row, both routes only read
// that row and answer its body verbatim. Around an epoch boundary the newest
// stored row is served, the charts print the epoch it belongs to.
//   GET /api/gov-action/pool-economics: builder route, session, rate limit.
//   GET /api/pool-economics: public route, same-origin only, any network.
import type { NetworkConfig } from '@/lib/config/network.js';
import { currentNetwork, jsonResponse, runtimeEnv } from '@/lib/api/response.js';
import { isSameOriginRequest } from '@/lib/http/origin.js';
import { gateGovActionRequest, GOV_ACTION_RATE_POLICIES } from './govActionGate.js';
import { loadPoolEconomics, loadPoolEconomicsEpoch } from './poolEconomics.js';

export interface PoolEconomicsDeps {
  network?: NetworkConfig;
  env?: Cloudflare.Env;
}

const NO_STORE = { 'cache-control': 'no-store' };
const PUBLIC_CACHE = { 'cache-control': 'public, max-age=3600' };
// A stored past epoch never changes, so it caches for a day.
const EPOCH_CACHE = { 'cache-control': 'public, max-age=86400' };
const EPOCH_PARAM = /^[1-9]\d{0,5}$/;

/** The stored row verbatim, or 503 when there is none yet or D1 fails. */
async function answerStored(db: D1Database, okHeaders: Record<string, string>, epoch?: number): Promise<Response> {
  try {
    const row = epoch === undefined ? await loadPoolEconomics(db) : await loadPoolEconomicsEpoch(db, epoch);
    if (!row && epoch !== undefined) return jsonResponse({ error: 'not_found' }, 404, NO_STORE);
    if (!row) return jsonResponse({ error: 'pool_data_unavailable' }, 503, NO_STORE);
    // The stored body is already the JSON answer, so it is passed through as is.
    return new Response(row.body, { status: 200, headers: { 'content-type': 'application/json', ...okHeaders } });
  } catch (err: unknown) {
    console.error('[pool-economics] read failed', err);
    return jsonResponse({ error: 'pool_data_unavailable' }, 503, NO_STORE);
  }
}

export async function handlePoolEconomics(
  ctx: { request: Request; locals: App.Locals },
  deps: PoolEconomicsDeps,
): Promise<Response> {
  const net = deps.network ?? currentNetwork();
  const gate = await gateGovActionRequest(ctx, GOV_ACTION_RATE_POLICIES.economics, { network: net, env: deps.env });
  if (gate instanceof Response) return gate;
  return answerStored(gate.db, NO_STORE);
}

export async function handlePublicPoolEconomics(
  ctx: { request: Request; locals: App.Locals },
  deps: { env?: Cloudflare.Env },
): Promise<Response> {
  if (!isSameOriginRequest(ctx.request)) return jsonResponse({ error: 'forbidden' }, 403, NO_STORE);
  const db = (deps.env ?? runtimeEnv(ctx.locals)).DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'pool_data_unavailable' }, 503, NO_STORE);
  const param = new URL(ctx.request.url).searchParams.get('epoch');
  if (param === null) return answerStored(db, PUBLIC_CACHE);
  if (!EPOCH_PARAM.test(param)) return jsonResponse({ error: 'not_found' }, 404, NO_STORE);
  return answerStored(db, EPOCH_CACHE, Number(param));
}

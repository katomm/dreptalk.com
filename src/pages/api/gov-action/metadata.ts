// POST /api/gov-action/metadata
// Finalizes an InfoAction CIP-108 metadata submission: verifies the optional
// author witness, pins the exact bytes to IPFS, and stores an audit row.
// preprod-only for now (mainnet is not wired up yet), so this and `prepare`
// share `gateInfoActionRequest`, which every gate (network, origin, session,
// bindings, IPFS secret, rate limit) runs through before either handler is
// called. Both routes enforce the gate independently since they can be hit
// directly, not just through the (also-gated) submit page.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv, currentNetwork } from '@/lib/api/response';
import type { NetworkConfig } from '@/lib/config/network';
import { isSameOriginRequest } from '@/lib/http/origin';
import { checkRate } from '@/lib/rate';
import { handleInfoActionMetadata } from '@/lib/governance/infoActionMetadataHandler';

export const prerender = false;

const RATE_MAX = 10;
const RATE_WINDOW_SEC = 60;

/**
 * Shared server gate for both InfoAction metadata routes (finalize + prepare).
 * `deps` lets tests inject a NetworkConfig/env stub instead of relying on the
 * global `cloudflare:workers` env, so every branch is deterministic.
 *
 * Order: preprod-only (404, hides the feature entirely on mainnet) -> same-origin
 * (403) -> signed-in (401) -> DB/RATE_LIMITER bindings present (503) -> PINATA_JWT
 * present (503, distinct message) -> per-user rate limit (429).
 */
export async function gateInfoActionRequest(
  ctx: { request: Request; locals: App.Locals },
  deps?: { network?: NetworkConfig; env?: Cloudflare.Env },
): Promise<Response | { db: D1Database; jwt: string; networkId: number }> {
  const net = deps?.network ?? currentNetwork();
  if (net.network !== 'preprod') return new Response('Not found', { status: 404 });

  if (!isSameOriginRequest(ctx.request)) return jsonResponse({ error: 'forbidden' }, 403);

  const user = ctx.locals.user;
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);

  const env = deps?.env ?? runtimeEnv(ctx.locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) return jsonResponse({ error: 'service unavailable' }, 503);

  const jwt = env.PINATA_JWT;
  if (!jwt) return jsonResponse({ error: 'ipfs hosting unavailable' }, 503);

  // The rate limiter is a Durable Object, so this is a network call that can
  // fail for reasons that have nothing to do with the request. Unguarded it
  // throws past the route into the generic 500 page, which tells neither the
  // user nor us anything. Log it and answer with the honest status instead.
  let allowed: boolean;
  try {
    allowed = await checkRate(rateLimiter, `gov-action-meta:${user.id}`, {
      max: RATE_MAX,
      windowSec: RATE_WINDOW_SEC,
      now: Date.now(),
    });
  } catch (err: unknown) {
    console.error('[gov-action] rate limiter unavailable', err);
    return jsonResponse({ error: 'service unavailable' }, 503);
  }
  if (!allowed) return jsonResponse({ error: 'rate_limited' }, 429);

  return { db, jwt, networkId: net.networkId };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await gateInfoActionRequest({ request, locals });
  if (gate instanceof Response) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const result = await handleInfoActionMetadata({
    body,
    db: gate.db,
    jwt: gate.jwt,
    now: Date.now(),
    expectedNetworkId: gate.networkId,
  });
  return jsonResponse(result.json, result.status);
};

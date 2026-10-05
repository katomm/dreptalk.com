// Shared server gate for every /api/gov-action/* route: preprod-only
// availability, same-origin, session, D1/rate-limiter bindings, an optional
// Pinata JWT, and a per-user rate limit. Extracted from the metadata route so
// the context route (which needs no JWT and a looser rate limit) can share
// the exact same check order instead of re-implementing it.
import { jsonResponse, runtimeEnv, currentNetwork } from '@/lib/api/response';
import type { NetworkConfig } from '@/lib/config/network';
import { isSameOriginRequest } from '@/lib/http/origin';
import { checkRate } from '@/lib/rate';
import { govActionSubmissionAvailable } from './submissionGate.js';

export interface GovActionGatePolicy {
  /** Rate-limit key prefix, combined with the user id (e.g. "gov-action-meta"). */
  rateKey: string;
  rateMax: number;
  rateWindowSec: number;
  /** Whether PINATA_JWT must be present. False for read-only routes that never upload. */
  requireJwt: boolean;
}

/** One policy per gov-action route family. Values fixed at review time, not runtime config. */
export const GOV_ACTION_RATE_POLICIES = {
  metadata: { rateKey: 'gov-action-meta', rateMax: 10, rateWindowSec: 60, requireJwt: true },
  document: { rateKey: 'gov-action-doc', rateMax: 10, rateWindowSec: 60, requireJwt: true },
  context: { rateKey: 'gov-action-ctx', rateMax: 30, rateWindowSec: 60, requireJwt: false },
} as const satisfies Record<string, GovActionGatePolicy>;

export interface GovActionGateResult {
  db: D1Database;
  /** Null only when the policy does not require a JWT. */
  jwt: string | null;
  /**
   * Our Pinata group. Absent is allowed and simply means an uploaded file is
   * never collectable, which is the safe direction to fail on a shared account.
   */
  groupId: string | undefined;
  networkId: number;
}

/**
 * Order: preprod-only (404, hides the feature entirely on mainnet) -> same-origin
 * (403) -> signed-in (401) -> DB/RATE_LIMITER bindings present (503) -> PINATA_JWT
 * present when the policy requires it (503, distinct message) -> per-user rate
 * limit (429).
 *
 * `deps` lets tests inject a NetworkConfig/env stub instead of relying on the
 * global `cloudflare:workers` env, so every branch is deterministic.
 */
export async function gateGovActionRequest(
  ctx: { request: Request; locals: App.Locals },
  policy: GovActionGatePolicy,
  deps?: { network?: NetworkConfig; env?: Cloudflare.Env },
): Promise<Response | GovActionGateResult> {
  const net = deps?.network ?? currentNetwork();
  if (!govActionSubmissionAvailable(net.network)) return new Response('Not found', { status: 404 });

  if (!isSameOriginRequest(ctx.request)) return jsonResponse({ error: 'forbidden' }, 403);

  const user = ctx.locals.user;
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);

  const env = deps?.env ?? runtimeEnv(ctx.locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) return jsonResponse({ error: 'service unavailable' }, 503);

  let jwt: string | null = null;
  if (policy.requireJwt) {
    jwt = env.PINATA_JWT ?? null;
    if (!jwt) return jsonResponse({ error: 'ipfs hosting unavailable' }, 503);
  }

  // The rate limiter is a Durable Object, so this is a network call that can
  // fail for reasons that have nothing to do with the request. Unguarded it
  // throws past the route into the generic 500 page, which tells neither the
  // user nor us anything. Log it and answer with the honest status instead.
  let allowed: boolean;
  try {
    allowed = await checkRate(rateLimiter, `${policy.rateKey}:${user.id}`, {
      max: policy.rateMax,
      windowSec: policy.rateWindowSec,
      now: Date.now(),
    });
  } catch (err: unknown) {
    console.error('[gov-action] rate limiter unavailable', err);
    return jsonResponse({ error: 'service unavailable' }, 503);
  }
  if (!allowed) return jsonResponse({ error: 'rate_limited' }, 429);

  const groupId = env.PINATA_GOV_GROUP_ID || undefined;

  return { db, jwt, groupId, networkId: net.networkId };
}

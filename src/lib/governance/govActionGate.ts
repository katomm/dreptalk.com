// Shared server gate for every /api/gov-action/* route: same-origin, session, D1/rate-limiter bindings, an optional Pinata JWT, a
// per-user rate limit, and for the routes that pin a per-IP and a global daily
// budget. Extracted from the metadata route so the context route (which needs
// no JWT and a looser rate limit) and the evaluate route can share the exact
// same check order instead of re-implementing it.
import { jsonResponse, runtimeEnv, currentNetwork } from '@/lib/api/response';
import type { NetworkConfig } from '@/lib/config/network';
import { isoDate } from '@/lib/format/date';
import { clientIpFrom, UNKNOWN_CLIENT_IP } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';
import { checkRate } from '@/lib/rate';

/**
 * Daily request budgets for a route that pins to IPFS, both reset at 00:00 UTC.
 * They bound the shared Pinata account (Free plan, 500 files in total, shared
 * with another project), where a login costs one wallet signature and so the
 * per-user limit alone bounds nothing. A request budget, not a pin count:
 * rejected and duplicate uploads count too.
 */
interface PinBudget {
  perIpMax: number;
  globalMax: number;
}

export interface GovActionGatePolicy {
  /** Rate-limit key prefix, combined with the user id (e.g. "gov-action-meta"). */
  rateKey: string;
  rateMax: number;
  rateWindowSec: number;
  /** Whether PINATA_JWT must be present. False for read-only routes that never upload. */
  requireJwt: boolean;
  /** Only on routes that pin. */
  pinBudget?: PinBudget;
}

/**
 * Worst case with the collector running: about 8 days of orphans x 2 networks
 * x 10 = 160 files. A NewConstitution needs two pins plus retries, so 5 per IP
 * is tight but enough for one proposer.
 */
const PIN_BUDGET: PinBudget = { perIpMax: 5, globalMax: 10 };

// The metadata finalize route and its prepare step share one per-user key, as
// they always have. Only finalize pins, so only it carries the pin budget.
const METADATA_POLICY = { rateKey: 'gov-action-meta', rateMax: 10, rateWindowSec: 60, requireJwt: true } as const;

/** One policy per gov-action route family. Values fixed at review time, not runtime config. */
export const GOV_ACTION_RATE_POLICIES = {
  metadata: { ...METADATA_POLICY, pinBudget: PIN_BUDGET },
  prepare: METADATA_POLICY,
  document: { rateKey: 'gov-action-doc', rateMax: 10, rateWindowSec: 60, requireJwt: true, pinBudget: PIN_BUDGET },
  context: { rateKey: 'gov-action-ctx', rateMax: 30, rateWindowSec: 60, requireJwt: false },
  status: { rateKey: 'gov-action-status', rateMax: 60, rateWindowSec: 60, requireJwt: false },
  economics: { rateKey: 'gov-action-econ', rateMax: 30, rateWindowSec: 60, requireJwt: false },
  evaluate: { rateKey: 'gov-action-eval', rateMax: 20, rateWindowSec: 60, requireJwt: false },
} as const satisfies Record<string, GovActionGatePolicy>;

const DAY_SEC = 86_400;

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
 * Order: same-origin (403) -> signed-in (401) -> DB/RATE_LIMITER bindings present (503) -> PINATA_JWT
 * present when the policy requires it (503, distinct message) -> per-user rate
 * limit (429 rate_limited) -> per-IP daily pin budget (429 pin_budget_ip,
 * skipped without a client IP, which only local dev lacks) -> global daily pin
 * budget per network (429 pin_budget_global).
 *
 * `deps` lets tests inject a NetworkConfig/env stub and a clock instead of
 * relying on the global `cloudflare:workers` env, so every branch is
 * deterministic.
 */
export async function gateGovActionRequest(
  ctx: { request: Request; locals: App.Locals },
  policy: GovActionGatePolicy,
  deps?: { network?: NetworkConfig; env?: Cloudflare.Env; now?: number },
): Promise<Response | GovActionGateResult> {
  const net = deps?.network ?? currentNetwork();
  const env = deps?.env ?? runtimeEnv(ctx.locals);

  if (!isSameOriginRequest(ctx.request)) return jsonResponse({ error: 'forbidden' }, 403);

  const user = ctx.locals.user;
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);

  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) return jsonResponse({ error: 'service unavailable' }, 503);

  let jwt: string | null = null;
  if (policy.requireJwt) {
    jwt = env.PINATA_JWT ?? null;
    if (!jwt) return jsonResponse({ error: 'ipfs hosting unavailable' }, 503);
  }

  const now = deps?.now ?? Date.now();
  // `warn`, when set, is logged on a refusal by that check.
  const checks: { key: string; max: number; windowSec: number; error: string; warn?: string }[] = [
    { key: `${policy.rateKey}:${user.id}`, max: policy.rateMax, windowSec: policy.rateWindowSec, error: 'rate_limited' },
  ];
  if (policy.pinBudget) {
    // The UTC calendar day makes both daily keys reset at 00:00 UTC.
    const day = isoDate(new Date(now));
    const ip = clientIpFrom(ctx.request.headers);
    if (ip !== UNKNOWN_CLIENT_IP) {
      checks.push({ key: `gov-action-pin-ip:${ip}:${day}`, max: policy.pinBudget.perIpMax, windowSec: DAY_SEC, error: 'pin_budget_ip' });
    }
    checks.push({
      key: `gov-action-pin-global:${net.network}:${day}`,
      max: policy.pinBudget.globalMax,
      windowSec: DAY_SEC,
      error: 'pin_budget_global',
      warn: `[gov-action] global pin budget exhausted on ${net.network}`,
    });
  }

  // In order, stopping at the first refusal, so a request the per-user limit
  // already refused never spends the IP or global budget. Each limiter call is
  // a Durable Object round trip that can fail for reasons that have nothing to
  // do with the request. Unguarded it throws past the route into the generic
  // 500 page, which tells neither the user nor us anything. Log it and answer
  // with the honest status instead.
  for (const check of checks) {
    let allowed: boolean;
    try {
      allowed = await checkRate(rateLimiter, check.key, { max: check.max, windowSec: check.windowSec, now });
    } catch (err: unknown) {
      console.error('[gov-action] rate limiter unavailable', err);
      return jsonResponse({ error: 'service unavailable' }, 503);
    }
    if (!allowed) {
      if (check.warn) console.warn(check.warn);
      return jsonResponse({ error: check.error }, 429);
    }
  }

  const groupId = env.PINATA_GOV_GROUP_ID || undefined;

  return { db, jwt, groupId, networkId: net.networkId };
}

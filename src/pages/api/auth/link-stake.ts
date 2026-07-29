// POST /api/auth/link-stake: the signed-in writer redeems a link-challenge
// nonce by proving control of a stake wallet (CIP-8 over a reward address,
// the same proof a proposer signs at login) and binds that stake address to
// their account. Thin route: gates + rate-limit + env wiring, all
// verification and the actual link live in handleLinkStake.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { handleLinkStake } from '@/lib/auth/linkStake';
import { isWriter } from '@/lib/auth/roles';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';
import { resolveNetwork } from '@/lib/config/network';

export const prerender = false;

// Authenticated and writer-gated, so the budget only needs to absorb a
// legitimate user retrying a stalled signing flow, not open internet abuse.
const USER_RATE_MAX = 10;
const IP_RATE_MAX = 20;
const RATE_WINDOW_SEC = 600;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = (locals as App.Locals).user;
    if (!user) return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    if (!isWriter(user.roles)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);
    if (!isSameOriginRequest(request)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

    const env = runtimeEnv(locals as App.Locals);
    const db = env.DB as D1Database | undefined;
    const rateLimiter = env.RATE_LIMITER;
    if (!db || !rateLimiter) return jsonResponse({ ok: false, error: 'service unavailable' }, 503);

    const clientIp = clientIpFrom(request.headers);
    const now = Date.now();
    const [userAllowed, ipAllowed] = await Promise.all([
      checkRate(rateLimiter, `linkst:u:${user.id}`, { max: USER_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
      checkRate(rateLimiter, `linkst:ip:${clientIp}`, { max: IP_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
    ]);
    if (!userAllowed || !ipAllowed) return jsonResponse({ ok: false, error: 'rate_limited' }, 429);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'invalid request' }, 400);
    }

    const networkEnv = (env.CARDANO_NETWORK as string | undefined) ?? null;
    const { network } = resolveNetwork(networkEnv);

    const result = await handleLinkStake({
      db,
      // The authenticated session's own id, never anything from the request
      // body -- this is what scopes the nonce domain to this exact account.
      userId: user.id,
      body: body as Parameters<typeof handleLinkStake>[0]['body'],
      network,
      now,
    });

    return jsonResponse(result.json, result.status);
  } catch {
    // Unexpected error (e.g. transient D1 or Durable Object RPC failure):
    // return a controlled 503 without leaking any internal detail.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

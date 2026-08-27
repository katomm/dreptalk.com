// POST /api/auth/co-proposer/redeem: the second step of invite redemption.
// The (still logged-out) invite holder proves their wallet with a CIP-8
// signature over the nonce from /challenge and, on success, becomes an
// active co-proposer with a grant-backed session. No signed-in gate. Thin
// route: rate-limit + env wiring, all verification and the claim itself live
// in handleRedeemGrant.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { handleRedeemGrant } from '@/lib/auth/coProposerRedeem';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';
import { resolveNetwork } from '@/lib/config/network';

export const prerender = false;

// Unauthenticated (the redeemer is logged out), so only a per-IP budget
// applies. Generous enough for a legitimate user retrying a stalled flow.
const IP_RATE_MAX = 10;
const RATE_WINDOW_SEC = 600;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!isSameOriginRequest(request)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

    const env = runtimeEnv(locals as App.Locals);
    const db = env.DB as D1Database | undefined;
    const sessionKv = env.SESSIONS as KVNamespace | undefined;
    const rateLimiter = env.RATE_LIMITER;
    if (!db || !sessionKv || !rateLimiter) return jsonResponse({ ok: false, error: 'service unavailable' }, 503);

    const clientIp = clientIpFrom(request.headers);
    const now = Date.now();
    const allowed = await checkRate(rateLimiter, `coprrd:ip:${clientIp}`, {
      max: IP_RATE_MAX,
      windowSec: RATE_WINDOW_SEC,
      now,
    });
    if (!allowed) return jsonResponse({ ok: false, error: 'rate_limited' }, 429);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'invalid request' }, 400);
    }

    const networkEnv = (env.CARDANO_NETWORK as string | undefined) ?? null;
    const { network } = resolveNetwork(networkEnv);
    const secure = new URL(request.url).protocol === 'https:';

    const result = await handleRedeemGrant({
      db,
      sessionKv,
      body: body as Parameters<typeof handleRedeemGrant>[0]['body'],
      network,
      // handleRedeemGrant (and the nonce helpers it calls) work in unix
      // seconds, not the ms epoch checkRate above needs -- see link-stake.ts,
      // which splits the same way.
      now: Math.floor(now / 1000),
      secure,
      userAgent: request.headers.get('user-agent'),
    });

    return jsonResponse(result.json, result.status, result.setCookie ? { 'set-cookie': result.setCookie } : undefined);
  } catch {
    // Unexpected error (e.g. transient D1 or Durable Object RPC failure):
    // return a controlled 503 without leaking any internal detail.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

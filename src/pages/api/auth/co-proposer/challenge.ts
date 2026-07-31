// POST /api/auth/co-proposer/challenge: the first step of invite redemption
// for a logged-out co-proposer. Takes the invite CODE (never a grantId --
// see coProposerRedeem.ts), resolves it server-side, and issues a nonce bound
// to that resolved grant. No signed-in gate: the redeemer has no session yet.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { handleRedeemChallenge } from '@/lib/auth/coProposerRedeem';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';

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
    const rateLimiter = env.RATE_LIMITER;
    if (!db || !rateLimiter) return jsonResponse({ ok: false, error: 'service unavailable' }, 503);

    const clientIp = clientIpFrom(request.headers);
    const now = Date.now();
    const allowed = await checkRate(rateLimiter, `coprch:ip:${clientIp}`, {
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
    const code = typeof (body as { code?: unknown })?.code === 'string' ? (body as { code: string }).code : '';

    const result = await handleRedeemChallenge({ db, code, now: Math.floor(now / 1000) });
    return jsonResponse(result.json, result.status);
  } catch {
    // Unexpected error (e.g. transient D1 or Durable Object RPC failure):
    // return a controlled 503 without leaking any internal detail.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

// POST /api/auth/link-challenge: issues a single-use nonce for a signed-in
// writer to prove ownership of a stake wallet they want to link to their
// account. The domain is bound to `link_stake:<user.id>`, so the proof this
// nonce produces can only ever be redeemed for this exact account and this
// exact intent (see consumeNonceForDomain), never replayed against a
// different account or a different flow.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { issueNonce } from '@/lib/auth/nonce';
import { isWriter } from '@/lib/auth/roles';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';

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
      checkRate(rateLimiter, `linkch:u:${user.id}`, { max: USER_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
      checkRate(rateLimiter, `linkch:ip:${clientIp}`, { max: IP_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
    ]);
    if (!userAllowed || !ipAllowed) return jsonResponse({ ok: false, error: 'rate_limited' }, 429);

    const { payload } = await issueNonce(db, { domain: `link_stake:${user.id}` });
    return jsonResponse({ payload });
  } catch {
    // Unexpected error (e.g. transient D1 or Durable Object RPC failure):
    // return a controlled 503 without leaking any internal detail.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

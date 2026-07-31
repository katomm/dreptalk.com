// POST /api/auth/co-proposer/withdraw: a signed-in proposer withdraws one of
// their own pending (never redeemed) invites. Thin route: same-origin +
// signed-in gate + rate-limit + env wiring, all guard logic and the delete
// itself live in handleWithdrawInvite (see coProposerManage.ts).
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { handleWithdrawInvite } from '@/lib/auth/coProposerManage';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';

export const prerender = false;

const USER_RATE_MAX = 10;
const IP_RATE_MAX = 20;
const RATE_WINDOW_SEC = 600;
// Grant ids are crypto.randomUUID() output (36 chars); the cap is generous
// headroom, not a tight fit to the real length.
const MAX_GRANT_ID_LEN = 100;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = (locals as App.Locals).user;
    if (!user) return jsonResponse({ error: 'unauthorized' }, 401);
    if (!isSameOriginRequest(request)) return jsonResponse({ error: 'forbidden' }, 403);

    const env = runtimeEnv(locals as App.Locals);
    const db = env.DB as D1Database | undefined;
    const rateLimiter = env.RATE_LIMITER;
    if (!db || !rateLimiter) return jsonResponse({ error: 'service unavailable' }, 503);

    const clientIp = clientIpFrom(request.headers);
    const now = Date.now();
    const [userAllowed, ipAllowed] = await Promise.all([
      checkRate(rateLimiter, `coprwd:u:${user.id}`, { max: USER_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
      checkRate(rateLimiter, `coprwd:ip:${clientIp}`, { max: IP_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
    ]);
    if (!userAllowed || !ipAllowed) return jsonResponse({ error: 'rate_limited' }, 429);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid request' }, 400);
    }
    const grantId = typeof (body as { grantId?: unknown })?.grantId === 'string' ? (body as { grantId: string }).grantId : '';
    if (grantId.length === 0 || grantId.length > MAX_GRANT_ID_LEN) {
      return jsonResponse({ error: 'invalid request' }, 400);
    }

    const result = await handleWithdrawInvite({ db, user, grantId });
    return jsonResponse(result.json, result.status);
  } catch {
    // Unexpected error (e.g. transient D1 or Durable Object RPC failure):
    // return a controlled 503 without leaking any internal detail.
    return jsonResponse({ error: 'service unavailable' }, 503);
  }
};

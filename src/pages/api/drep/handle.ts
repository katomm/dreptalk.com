import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';
import { claimHandleRequest } from '@/lib/drepLink/claimRequest';

export const prerender = false;

const USER_RATE_MAX = 10;
const IP_RATE_MAX = 20;
const RATE_WINDOW_SEC = 600;

// A DRep changes its drep.link handle. All rules live in claimHandleRequest.
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = (locals as App.Locals).user;
    if (!user) return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    if (!isSameOriginRequest(request)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);
    const env = runtimeEnv(locals as App.Locals);
    const db = env.DB as D1Database | undefined;
    const rateLimiter = env.RATE_LIMITER;
    if (!db || !rateLimiter) return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
    const now = Date.now();
    const [userAllowed, ipAllowed] = await Promise.all([
      checkRate(rateLimiter, `drlink:u:${user.id}`, { max: USER_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
      checkRate(rateLimiter, `drlink:ip:${clientIpFrom(request.headers)}`, {
        max: IP_RATE_MAX,
        windowSec: RATE_WINDOW_SEC,
        now,
      }),
    ]);
    if (!userAllowed || !ipAllowed) return jsonResponse({ ok: false, error: 'rate_limited' }, 429);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'bad_request' }, 400);
    }
    const r = await claimHandleRequest({ db, user, body, now: Math.floor(now / 1000) });
    return jsonResponse(r.body, r.status);
  } catch {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

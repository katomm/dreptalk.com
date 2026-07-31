// POST /api/auth/co-proposer/invite: a signed-in proposer creates a one-time
// invite link for a new co-proposer. Thin route: same-origin + signed-in gate
// + rate-limit + env wiring, all guard logic and the invite itself live in
// handleCreateInvite (see coProposerManage.ts).
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { handleCreateInvite } from '@/lib/auth/coProposerManage';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';

export const prerender = false;

// Authenticated and guard-gated, so the budget only needs to absorb a
// legitimate proposer retrying, not open internet abuse.
const USER_RATE_MAX = 10;
const IP_RATE_MAX = 20;
const RATE_WINDOW_SEC = 600;

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
      checkRate(rateLimiter, `coprinv:u:${user.id}`, { max: USER_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
      checkRate(rateLimiter, `coprinv:ip:${clientIp}`, { max: IP_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
    ]);
    if (!userAllowed || !ipAllowed) return jsonResponse({ error: 'rate_limited' }, 429);

    const result = await handleCreateInvite({ db, user, now: Math.floor(now / 1000) });
    return jsonResponse(result.json, result.status);
  } catch {
    // Unexpected error (e.g. transient D1 or Durable Object RPC failure):
    // return a controlled 503 without leaking any internal detail.
    return jsonResponse({ error: 'service unavailable' }, 503);
  }
};

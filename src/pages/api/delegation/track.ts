// POST /api/delegation/track: the signed-in writer opts into ongoing
// delegation tracking after linking a stake wallet (Task 6,
// users.stake_addr). Thin route: gates + rate-limit + env wiring, all
// tracking logic (ensureFollow + fail-soft resolveFollow) lives in
// handleTrack.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { handleTrack } from '@/lib/delegation/track';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';
import { resolveNetwork } from '@/lib/config/network';
import { createKoiosClient } from '@/lib/koios/client';

export const prerender = false;

// Authenticated, so the budget only needs to absorb a legitimate user
// retrying (e.g. a slow Koios lookup), not open internet abuse.
const USER_RATE_MAX = 10;
const IP_RATE_MAX = 20;
const RATE_WINDOW_SEC = 600;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = (locals as App.Locals).user;
    if (!user) return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    if (!isSameOriginRequest(request)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

    const env = runtimeEnv(locals as App.Locals);
    const db = env.DB as D1Database | undefined;
    const rateLimiter = env.RATE_LIMITER;
    if (!db || !rateLimiter) return jsonResponse({ ok: false, error: 'service unavailable' }, 503);

    const clientIp = clientIpFrom(request.headers);
    const now = Date.now();
    const [userAllowed, ipAllowed] = await Promise.all([
      checkRate(rateLimiter, `deltrk:u:${user.id}`, { max: USER_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
      checkRate(rateLimiter, `deltrk:ip:${clientIp}`, { max: IP_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
    ]);
    if (!userAllowed || !ipAllowed) return jsonResponse({ ok: false, error: 'rate_limited' }, 429);

    const networkEnv = (env.CARDANO_NETWORK as string | undefined) ?? null;
    const { koiosBaseUrl } = resolveNetwork(networkEnv);
    // Optional Koios API key, same convention as verify.ts: sent as a Bearer
    // token when set, anonymous requests otherwise.
    const koiosToken = (env.KOIOS_API_KEY as string | undefined) || undefined;
    const koios = createKoiosClient({ baseUrl: koiosBaseUrl, token: koiosToken });

    const result = await handleTrack({
      db,
      koios,
      // The authenticated session's own id, never anything from the request
      // body -- there is no request body for this endpoint.
      userId: user.id,
      now: Math.floor(now / 1000),
    });

    return jsonResponse(result.json, result.status);
  } catch {
    // Unexpected error (e.g. transient D1 or Durable Object RPC failure):
    // return a controlled 503 without leaking any internal detail.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

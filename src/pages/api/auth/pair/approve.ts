// POST /api/auth/pair/approve: the signed-in half of device pairing. Marks a
// pending pairing approved and stamps it with the approver's user id and role
// cap. Roles are still re-resolved (revocation-aware) when the device
// redeems; the snapshot here only bounds what that resolution can grant.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { approvePairing } from '@/lib/auth/pairing';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';

export const prerender = false;

// This is the endpoint an attacker would guess against, so attempts are capped
// per user and per IP. Every attempt is counted: the rate limit runs before the
// database work, and that ordering is what protects the endpoint. The budget is
// far above legitimate use, so counting successes costs nothing in practice.
const USER_RATE_MAX = 10;
const IP_RATE_MAX = 20;
const RATE_WINDOW_SEC = 600;

const bodySchema = z.object({ code: z.string().min(1).max(32) });

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
      checkRate(rateLimiter, `pairapp:u:${user.id}`, { max: USER_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
      checkRate(rateLimiter, `pairapp:i:${clientIp}`, { max: IP_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
    ]);
    if (!userAllowed || !ipAllowed) return jsonResponse({ ok: false, error: 'rate_limited' }, 429);

    let parsed: { code: string };
    try {
      parsed = bodySchema.parse(await request.json());
    } catch {
      return jsonResponse({ ok: false, error: 'invalid request' }, 400);
    }

    const approved = await approvePairing(db, parsed.code, user.id, user.roles);
    // A clear failure, so a typo reads as a typo instead of stranding the user
    // watching a phone that never signs in. Expired and unknown stay merged.
    if (!approved) return jsonResponse({ ok: false, error: 'unknown_code' }, 404);

    return jsonResponse({ ok: true });
  } catch {
    // Unexpected error (e.g. Durable Object RPC failure or a transient D1
    // error): return a controlled 503 without leaking any internal detail.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

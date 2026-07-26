// POST /api/auth/pair/lookup: previews a pending pairing so the approver sees
// what is asking for access before consenting. Requires a session; changes
// nothing.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { lookupPairing } from '@/lib/auth/pairing';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';

export const prerender = false;

const RATE_MAX = 10;
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
    const allowed = await checkRate(rateLimiter, `pairlook:${user.id}:${clientIp}`, {
      max: RATE_MAX,
      windowSec: RATE_WINDOW_SEC,
      now: Date.now(),
    });
    if (!allowed) return jsonResponse({ ok: false, error: 'rate_limited' }, 429);

    let parsed: { code: string };
    try {
      parsed = bodySchema.parse(await request.json());
    } catch {
      return jsonResponse({ ok: false, error: 'invalid request' }, 400);
    }

    const found = await lookupPairing(db, parsed.code);
    // Unknown, already used and expired codes are one answer, so a wrong code
    // cannot be used to probe which codes exist.
    if (!found) return jsonResponse({ ok: false, error: 'unknown_code' }, 404);

    return jsonResponse({ ok: true, userAgent: found.userAgent, createdAt: found.createdAt });
  } catch {
    // Unexpected error (e.g. Durable Object RPC failure or a transient D1
    // error): return a controlled 503 without leaking any internal detail.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};

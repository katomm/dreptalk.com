// POST /api/auth/pair/start: mints a device pairing for a device that cannot
// sign in on its own (typically the installed mobile PWA, where no CIP-30 wallet
// extension exists). Public: the pairing is worthless until a signed-in session
// approves it.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createPairing } from '@/lib/auth/pairing';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';

export const prerender = false;

const RATE_MAX = 5;
const RATE_WINDOW_SEC = 600;

export const POST: APIRoute = async ({ request }) => {
  try {
    const db = env.DB as D1Database | undefined;
    const rateLimiter = env.RATE_LIMITER;
    if (!db || !rateLimiter) {
      return new Response(JSON.stringify({ ok: false, error: 'service unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (!isSameOriginRequest(request)) {
      return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }

    const clientIp = clientIpFrom(request.headers);
    const allowed = await checkRate(rateLimiter, `pairstart:${clientIp}`, {
      max: RATE_MAX,
      windowSec: RATE_WINDOW_SEC,
      now: Date.now(),
    });
    if (!allowed) {
      return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Captured only to show the approver what is asking for access. It is a
    // sanity check for the user, never a security boundary.
    const userAgent = (request.headers.get('user-agent') ?? '').slice(0, 256) || null;

    const pairing = await createPairing(db, { userAgent });

    return new Response(
      JSON.stringify({
        ok: true,
        pairingId: pairing.pairingId,
        deviceSecret: pairing.deviceSecret,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  } catch {
    // Unexpected error (e.g. D1 failure or Durable Object RPC issue): return a
    // controlled 503 without leaking any internal detail.
    return new Response(JSON.stringify({ ok: false, error: 'service unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
};

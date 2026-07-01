import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleChallenge } from '@/lib/auth/handlers';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';

export const prerender = false;

// Per-IP rate limit: nonce issuance is unauthenticated, so cap it to stop a
// single client from flooding the nonce store. Users legitimately issue ~1 per
// login attempt; 30/min/IP is generous.
const RATE_MAX = 30;
const RATE_WINDOW_SEC = 60;

// Accept only a plausible Host (letters, digits, dot, hyphen, optional :port).
// The Host is echoed into the challenge payload (shown to the user in a signing
// command), so reject anything that could carry control characters or markup.
const HOST_RE = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

export const POST: APIRoute = async ({ request }) => {
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) {
    return new Response(JSON.stringify({ ok: false, error: 'service unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const clientIp = clientIpFrom(request.headers);
  const allowed = await checkRate(rateLimiter, `authch:${clientIp}`, {
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

  const rawHost = request.headers.get('Host') ?? 'unknown';
  const domain = HOST_RE.test(rawHost) ? rawHost : 'unknown';
  const result = await handleChallenge({ db, domain });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

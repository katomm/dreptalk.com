import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleVerify } from '@/lib/auth/handlers';
import { resolveNetwork } from '@/lib/config/network';
import { createKoiosClient } from '@/lib/koios/client';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { parseModerators } from '../../../../config/moderators.js';

export const prerender = false;

// Per-IP rate limit: verify is unauthenticated and does a signature check plus a
// Koios lookup per request, so cap it to prevent CPU/Koios-amplification DoS.
const RATE_MAX = 10;
const RATE_WINDOW_SEC = 60;

export const POST: APIRoute = async ({ request }) => {
  try {
    const nonceKv = env.NONCES as KVNamespace | undefined;
    const sessionKv = env.SESSIONS as KVNamespace | undefined;
    const db = env.DB as D1Database | undefined;

    if (!nonceKv || !sessionKv || !db) {
      return new Response(JSON.stringify({ ok: false, error: 'service unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Throttle per IP before any signature verification or Koios call.
    const clientIp = clientIpFrom(request.headers);
    const allowed = await checkRate(nonceKv, `authvf:${clientIp}`, {
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: 'invalid JSON' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const networkEnv = (env.CARDANO_NETWORK as string | undefined) ?? null;
    const { network, koiosBaseUrl } = resolveNetwork(networkEnv);
    // Optional Koios API key: when KOIOS_API_KEY is set it is sent as a Bearer
    // token (higher rate limits); when unset the client falls back to anonymous
    // requests, so no configuration is required.
    const koiosToken = (env.KOIOS_API_KEY as string | undefined) || undefined;
    const koios = createKoiosClient({ baseUrl: koiosBaseUrl, token: koiosToken });
    const secure = new URL(request.url).protocol === 'https:';

    // Moderator / admin allowlist from the MODERATORS env value (empty by default).
    const moderators = parseModerators(env.MODERATORS as string | undefined);

    const result = await handleVerify(
      {
        body: body as Parameters<typeof handleVerify>[0]['body'],
        nonceKv,
        sessionKv,
        db,
        koios,
        network,
        secure,
      },
      { getModeratorRole: (stakeAddr) => moderators.get(stakeAddr) ?? null },
    );

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (result.setCookie) {
      headers['set-cookie'] = result.setCookie;
    }
    return new Response(JSON.stringify(result.json), {
      status: result.status,
      headers,
    });
  } catch {
    // Unexpected setup error (e.g. misconfigured CARDANO_NETWORK): return a
    // controlled 503 without leaking any internal detail.
    return new Response(JSON.stringify({ ok: false, error: 'service unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
};

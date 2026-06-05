import type { APIRoute } from 'astro';
import { handleVerify } from '@/lib/auth/handlers';
import { resolveNetwork } from '@/lib/config/network';
import { createKoiosClient } from '@/lib/koios/client';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as { runtime?: { env?: Record<string, unknown> } }).runtime?.env ?? {};
    const nonceKv = env.NONCES as KVNamespace | undefined;
    const sessionKv = env.SESSIONS as KVNamespace | undefined;
    const db = env.DB as D1Database | undefined;

    if (!nonceKv || !sessionKv || !db) {
      return new Response(JSON.stringify({ ok: false, error: 'service unavailable' }), {
        status: 503,
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
    const koios = createKoiosClient({ baseUrl: koiosBaseUrl });
    const secure = new URL(request.url).protocol === 'https:';

    const result = await handleVerify({
      body: body as Parameters<typeof handleVerify>[0]['body'],
      nonceKv,
      sessionKv,
      db,
      koios,
      network,
      secure,
    });

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

import type { APIRoute } from 'astro';
import { handleChallenge } from '@/lib/auth/handlers';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, unknown> } }).runtime?.env ?? {};
  const nonceKv = env.NONCES as KVNamespace | undefined;
  if (!nonceKv) {
    return new Response(JSON.stringify({ ok: false, error: 'service unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const domain = request.headers.get('Host') ?? 'unknown';
  const result = await handleChallenge({ nonceKv, domain });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleLogout } from '@/lib/auth/handlers';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const sessionKv = env.SESSIONS as KVNamespace | undefined;

  if (!sessionKv) {
    return new Response(JSON.stringify({ ok: false, error: 'service unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const cookieHeader = request.headers.get('Cookie');
  const result = await handleLogout({ sessionKv, cookieHeader });

  return new Response(JSON.stringify(result.json), {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      'set-cookie': result.setCookie,
    },
  });
};

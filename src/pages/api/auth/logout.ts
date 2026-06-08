import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleLogout } from '@/lib/auth/handlers';

export const prerender = false;

// The header's Logout control is a plain <form method="POST"> (the strict CSP
// forbids inline scripts), so on success we clear the session cookie and send a
// 303 redirect to the home page rather than a JSON body.
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

  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': result.setCookie,
    },
  });
};

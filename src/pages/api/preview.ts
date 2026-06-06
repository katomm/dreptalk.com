import type { APIRoute } from 'astro';
import { renderMarkdown } from '@/lib/markdown.js';
import { checkRate } from '@/lib/rate.js';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const env = (locals as App.Locals).runtime?.env ?? {};
  const noncesKv = env.NONCES as KVNamespace | undefined;

  if (noncesKv) {
    const allowed = await checkRate(noncesKv, `preview:${user.id}`, {
      max: 60,
      windowSec: 60,
      now: Date.now(),
    });
    if (!allowed) {
      return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
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

  const rawMd = typeof (body as { bodyMd?: unknown }).bodyMd === 'string'
    ? (body as { bodyMd: string }).bodyMd.trim()
    : '';

  if (rawMd.length > 20000) {
    return new Response(JSON.stringify({ ok: false, error: 'body too long' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const html = renderMarkdown(rawMd);

  return new Response(JSON.stringify({ html }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

import type { APIRoute } from 'astro';
import { renderMarkdown } from '@/lib/markdown.js';
import { checkRate } from '@/lib/rate.js';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  const env = runtimeEnv(locals as App.Locals);
  const noncesKv = env.NONCES as KVNamespace | undefined;

  // Rate-limit KV is required; 503 when unbound so preview stays rate-limited.
  if (!noncesKv) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }

  const allowed = await checkRate(noncesKv, `preview:${user.id}`, {
    max: 60,
    windowSec: 60,
    now: Date.now(),
  });
  if (!allowed) {
    return jsonResponse({ ok: false, error: 'rate_limited' }, 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON' }, 400);
  }

  const rawMd = typeof (body as { bodyMd?: unknown }).bodyMd === 'string'
    ? (body as { bodyMd: string }).bodyMd.trim()
    : '';

  if (rawMd.length > 20000) {
    return jsonResponse({ ok: false, error: 'body too long' }, 400);
  }

  const html = renderMarkdown(rawMd);

  return jsonResponse({ html });
};

// POST /api/notifications/test: sends a real, slightly delayed test push to
// one of the signed-in user's own devices, through the full pipeline. The
// route responds immediately (202) and the delayed send runs in waitUntil;
// the delay gives the user time to lock the screen so the banner actually
// shows. Rate limited so nobody floods the push services.
import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { listChannels } from '@/lib/db/notificationChannels';
import { sendWebPush } from '@/lib/push/webPush';
import { sendTestPush, TEST_PUSH_DELAY_MS } from '@/lib/notifications/testPush';

export const prerender = false;

const schema = z.object({ id: z.string().min(1).max(64) });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as App.Locals).user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return jsonResponse({ ok: false, error: 'push not configured' }, 503);
  }

  // 5 test pushes per hour per user: enough to debug a setup, not a flood.
  const allowed = await checkRate(rateLimiter, `pushtest:${user.id}`, { max: 5, windowSec: 3600, now: Date.now() });
  if (!allowed) {
    return jsonResponse({ ok: false, error: 'rate_limited' }, 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid input' }, 400);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ ok: false, error: 'invalid input' }, 400);
  }

  // Ownership is checked before responding so the client gets an honest 404;
  // sendTestPush re-checks it anyway.
  const owned = (await listChannels(db, user.id)).some(
    (row) => row.id === parsed.data.id && row.channel === 'webpush',
  );
  if (!owned) {
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }

  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: 'https://dreptalk.com',
  };
  waitUntil(
    sendTestPush(db, vapid, { userId: user.id, channelId: parsed.data.id }, { send: sendWebPush, sleep })
      .then((outcome) => {
        if (outcome !== 'sent') console.warn(`[push-test] delayed send outcome: ${outcome}`);
      })
      // A throwing send (malformed stored target, network error) must not
      // become an unhandled rejection; the client already got its 202.
      .catch((err) => console.error('[push-test] delayed send threw', err)),
  );

  return jsonResponse({ ok: true, delayMs: TEST_PUSH_DELAY_MS }, 202);
};

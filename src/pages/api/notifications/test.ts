// POST /api/notifications/test: sends a real test message to one of the
// signed-in user's own channels, through the full pipeline. For webpush the
// route responds immediately (202) and a slightly delayed send runs in
// waitUntil, giving the user time to lock the screen so the banner actually
// shows; for telegram the send happens immediately, no delay needed. Rate
// limited so nobody floods the push services.
import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { listChannels } from '@/lib/db/notificationChannels';
import { sendWebPush } from '@/lib/push/webPush';
import { sendTelegramMessage } from '@/lib/push/telegram';
import { sendTestPush, sendTestTelegram, TEST_PUSH_DELAY_MS } from '@/lib/notifications/testPush';

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
  // the send functions re-check it anyway.
  const channel = (await listChannels(db, user.id)).find((row) => row.id === parsed.data.id);
  if (!channel) {
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }

  if (channel.channel === 'telegram') {
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return jsonResponse({ ok: false, error: 'telegram not configured' }, 503);
    }
    const outcome = await sendTestTelegram(db, botToken, { userId: user.id, channelId: channel.id }, { send: sendTelegramMessage });
    if (outcome === 'sent') {
      return jsonResponse({ ok: true, delayMs: 0 }, 202);
    }
    return jsonResponse({ ok: false, error: 'send_failed' }, 502);
  }

  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return jsonResponse({ ok: false, error: 'push not configured' }, 503);
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

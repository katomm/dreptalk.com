// POST /api/notifications/telegram-link: issues a one-time deep link that
// connects the signed-in user's Telegram account via the bot's /start payload.
// Rate limited lightly; codes expire from KV on their own.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { issueLinkCode } from '@/lib/notifications/telegramLink';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as App.Locals).user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  const env = runtimeEnv(locals as App.Locals);
  const kv = env.SESSIONS as KVNamespace | undefined;
  const rateLimiter = env.RATE_LIMITER;
  const botUsername = env.TELEGRAM_BOT_USERNAME as string | undefined;
  if (!kv || !rateLimiter) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
  if (!botUsername) {
    return jsonResponse({ ok: false, error: 'telegram not configured' }, 503);
  }

  // 10 links per hour per user: reconnect loops stay possible, abuse does not.
  const allowed = await checkRate(rateLimiter, `tglink:${user.id}`, { max: 10, windowSec: 3600, now: Date.now() });
  if (!allowed) {
    return jsonResponse({ ok: false, error: 'rate_limited' }, 429);
  }

  const code = await issueLinkCode(kv, user.id);
  return jsonResponse({ ok: true, url: `https://t.me/${botUsername}?start=${code}` });
};

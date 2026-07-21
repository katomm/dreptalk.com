// POST /api/telegram/webhook: Telegram delivers bot updates here. Callers are
// authenticated by the X-Telegram-Bot-Api-Secret-Token header, which must
// equal the TELEGRAM_WEBHOOK_SECRET set when the webhook was registered via
// setWebhook. Always answers 200 to authenticated requests (even when the
// update is malformed or handling fails) so Telegram does not retry-storm;
// failures are logged instead.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { resolveNetwork } from '@/lib/config/network';
import { sendTelegramMessage } from '@/lib/push/telegram';
import { handleTelegramUpdate } from '@/lib/notifications/telegramWebhook';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const kv = env.SESSIONS as KVNamespace | undefined;
  const botToken = env.TELEGRAM_BOT_TOKEN as string | undefined;
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET as string | undefined;
  if (!db || !kv || !botToken || !webhookSecret) {
    return jsonResponse({ ok: false, error: 'not configured' }, 503);
  }
  if (request.headers.get('x-telegram-bot-api-secret-token') !== webhookSecret) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return jsonResponse({ ok: true });
  }

  const { siteOrigin } = resolveNetwork((env.CARDANO_NETWORK as string | undefined) ?? null);
  try {
    await handleTelegramUpdate(db, kv, update, {
      reply: (chatId, text) => sendTelegramMessage(botToken, chatId, text),
      origin: siteOrigin,
      now: Date.now(),
    });
  } catch (err) {
    console.error('[telegram-webhook] update handling failed', err);
  }
  return jsonResponse({ ok: true });
};

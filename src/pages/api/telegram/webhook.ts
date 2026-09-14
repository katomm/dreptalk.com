// POST /api/telegram/webhook: Telegram delivers bot updates here. Callers are
// authenticated by the X-Telegram-Bot-Api-Secret-Token header, which must
// equal the TELEGRAM_WEBHOOK_SECRET set when the webhook was registered via
// setWebhook. Always answers 200 to authenticated requests (even when the
// update is malformed or handling fails) so Telegram does not retry-storm;
// failures are logged instead.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { secretsEqual } from '@/lib/crypto/secretsEqual';
import { resolveNetwork } from '@/lib/config/network';
import { sendTelegramMessage, deleteTelegramMessage, banTelegramChatMember } from '@/lib/push/telegram';
import { handleTelegramUpdate, type TelegramWebhookDeps } from '@/lib/notifications/telegramWebhook';
import { parseGroupGuardConfig, type GroupGuardConfig } from '@/lib/notifications/telegramGroupGuard';

export const prerender = false;

// The guard config is an env string that never changes within an isolate, so
// it is parsed (and its patterns compiled) once, not per webhook request.
let guardCfgRaw: string | undefined;
let guardCfg: GroupGuardConfig | undefined;
function groupGuardConfig(raw: string | undefined): GroupGuardConfig {
  if (!guardCfg || raw !== guardCfgRaw) {
    guardCfgRaw = raw;
    guardCfg = parseGroupGuardConfig(raw);
  }
  return guardCfg;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const kv = env.SESSIONS as KVNamespace | undefined;
  const botToken = env.TELEGRAM_BOT_TOKEN as string | undefined;
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET as string | undefined;
  if (!db || !kv || !botToken || !webhookSecret) {
    return jsonResponse({ ok: false, error: 'not configured' }, 503);
  }
  const presented = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!(await secretsEqual(presented, webhookSecret))) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return jsonResponse({ ok: true });
  }

  const { siteOrigin } = resolveNetwork((env.CARDANO_NETWORK as string | undefined) ?? null);
  // The group guard is on only where a group chat id is configured (mainnet).
  // Its thresholds come from a secret so the deployed values stay out of the repo.
  const groupChatId = env.TELEGRAM_GROUP_CHAT_ID as string | undefined;
  const botUsername = env.TELEGRAM_BOT_USERNAME as string | undefined;
  const group: TelegramWebhookDeps['group'] =
    groupChatId && botUsername
      ? {
          target: {
            chatId: groupChatId,
            botUsername,
            cfg: groupGuardConfig(env.TELEGRAM_GROUP_GUARD as string | undefined),
          },
          deps: {
            deleteMessage: (chatId, messageId) => deleteTelegramMessage(botToken, chatId, messageId),
            banChatMember: (chatId, userId) => banTelegramChatMember(botToken, chatId, userId),
          },
        }
      : undefined;
  try {
    await handleTelegramUpdate(db, kv, update, {
      reply: (chatId, text) => sendTelegramMessage(botToken, chatId, text),
      origin: siteOrigin,
      now: Date.now(),
      group,
    });
  } catch (err) {
    console.error('[telegram-webhook] update handling failed', err);
  }
  return jsonResponse({ ok: true });
};

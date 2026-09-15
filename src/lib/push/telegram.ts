// Telegram Bot API sender for notification delivery. One plain fetch per
// message; the bot token is a Worker secret and must never appear in logs or
// stored data. Chat-dead detection mirrors the web push 404/410 prune: a 403
// means the user blocked (or deleted) the bot, a 400 "chat not found" means
// the chat id is gone; both mean the channel row should be removed.

export interface TelegramSendResult {
  ok: boolean;
  /** HTTP status from api.telegram.org; 0 when fetch itself failed. */
  status: number;
  /** Telegram's error description, '' when unavailable. */
  description: string;
}

/** One Bot API method call with a JSON body. Never throws; failures come back in the result. */
async function callTelegram(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<TelegramSendResult> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, status: res.status, description: '' };
    let description = '';
    try {
      description = ((await res.json()) as { description?: string }).description ?? '';
    } catch {
      // Non-JSON error body; the status is enough for the caller.
    }
    return { ok: false, status: res.status, description };
  } catch (err) {
    return { ok: false, status: 0, description: err instanceof Error ? err.message : String(err) };
  }
}

/** Sends one plain-text message to a chat. Never throws; failures come back in the result. */
export function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  return callTelegram(
    botToken,
    'sendMessage',
    // The notifications link would otherwise unfurl into a large preview
    // card under every message; keep the bundle compact.
    { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
    fetchImpl,
  );
}

/** Deletes one message in a chat the bot administers. Never throws. */
export function deleteTelegramMessage(
  botToken: string,
  chatId: string,
  messageId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  return callTelegram(botToken, 'deleteMessage', { chat_id: chatId, message_id: messageId }, fetchImpl);
}

/** Bans one member from a chat the bot administers. Never throws. */
export function banTelegramChatMember(
  botToken: string,
  chatId: string,
  userId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  return callTelegram(botToken, 'banChatMember', { chat_id: chatId, user_id: userId }, fetchImpl);
}

/** True when the chat can never be reached again and the channel row should be pruned. */
export function isTelegramChatDead(result: TelegramSendResult): boolean {
  if (result.ok) return false;
  if (result.status === 403) return true;
  return result.status === 400 && /chat not found/i.test(result.description);
}

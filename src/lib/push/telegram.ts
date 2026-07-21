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

/** Sends one plain-text message to a chat. Never throws; failures come back in the result. */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // The notifications link would otherwise unfurl into a large preview
        // card under every message; keep the bundle compact.
        link_preview_options: { is_disabled: true },
      }),
    });
    if (res.ok) return { ok: true, status: res.status, description: '' };
    let description = '';
    try {
      const body = (await res.json()) as { description?: string };
      description = body.description ?? '';
    } catch {
      // Non-JSON error body (proxy page, empty); status alone still routes the outcome.
    }
    return { ok: false, status: res.status, description };
  } catch (err) {
    return { ok: false, status: 0, description: err instanceof Error ? err.message : String(err) };
  }
}

/** True when the chat can never be reached again and the channel row should be pruned. */
export function isTelegramChatDead(result: TelegramSendResult): boolean {
  if (result.ok) return false;
  if (result.status === 403) return true;
  return result.status === 400 && /chat not found/i.test(result.description);
}

/// <reference types="@cloudflare/workers-types" />
// Handles one Telegram webhook update. Only private text messages matter:
// "/start <code>" links the chat to the code's user, "/stop" disconnects the
// chat, anything else gets a short help reply. The reply sender is injected so
// the logic tests without Telegram traffic; the API route binds it to
// sendTelegramMessage with the bot token.

import { consumeLinkCode } from './telegramLink.js';
import { addChannel, deleteChannelsByEndpoint } from '../db/notificationChannels.js';

export type TelegramWebhookOutcome = 'linked' | 'link_invalid' | 'stopped' | 'help' | 'ignored';

export interface TelegramWebhookDeps {
  reply: (chatId: string, text: string) => Promise<unknown>;
  /** Site origin for links in replies, e.g. https://dreptalk.com */
  origin: string;
  now: number;
}

/** Extracts text + chat id from an arbitrary update payload; null when either is missing. */
function readMessage(update: unknown): { text: string; chatId: string } | null {
  if (typeof update !== 'object' || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const text = (message as { text?: unknown }).text;
  const chat = (message as { chat?: unknown }).chat;
  if (typeof text !== 'string' || typeof chat !== 'object' || chat === null) return null;
  const id = (chat as { id?: unknown }).id;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  return { text, chatId: String(id) };
}

/** Processes one update end to end, including the reply. Never throws on malformed input. */
export async function handleTelegramUpdate(
  db: D1Database,
  kv: KVNamespace,
  update: unknown,
  deps: TelegramWebhookDeps,
): Promise<TelegramWebhookOutcome> {
  const msg = readMessage(update);
  if (!msg) return 'ignored';
  const endpoint = `telegram:${msg.chatId}`;

  const startCode = msg.text.match(/^\/start\s+(\S+)/)?.[1];
  if (startCode) {
    const userId = await consumeLinkCode(kv, startCode);
    if (!userId) {
      await deps.reply(msg.chatId, 'This link has expired. Get a fresh one from your notification settings on DRepTalk.');
      return 'link_invalid';
    }
    await addChannel(db, { userId, channel: 'telegram', target: msg.chatId, endpoint, now: deps.now });
    await deps.reply(msg.chatId, "Connected! You'll get DRepTalk notifications here. Send /stop to disconnect.");
    return 'linked';
  }

  if (/^\/stop\b/.test(msg.text)) {
    await deleteChannelsByEndpoint(db, endpoint);
    await deps.reply(msg.chatId, 'Disconnected. This chat will not receive DRepTalk notifications anymore.');
    return 'stopped';
  }

  await deps.reply(
    msg.chatId,
    `This bot delivers DRepTalk notifications. Connect it from your notification settings: ${deps.origin}/notifications/`,
  );
  return 'help';
}

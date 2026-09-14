/// <reference types="@cloudflare/workers-types" />
// Handles one Telegram webhook update. Private text messages drive linking:
// "/start <code>" links the chat to the code's user, "/stop" disconnects the
// chat, anything else gets a short help reply. Updates from the one public
// group the bot moderates (when configured) go to the anti-spam guard instead
// and are never replied to. The Telegram calls are injected so the logic tests
// without traffic; the API route binds them to the bot token. A /start also
// captures a human-readable label (the chat's @username, or its first name as
// a fallback) that is stored on the channel row for display in settings.

import { consumeLinkCode } from './telegramLink.js';
import { addChannel, deleteChannelsByEndpoint } from '../db/notificationChannels.js';
import { handleGroupUpdate, type GroupGuardDeps, type GroupGuardOutcome, type GroupGuardTarget } from './telegramGroupGuard.js';

export type TelegramWebhookOutcome =
  | 'linked'
  | 'link_invalid'
  | 'stopped'
  | 'help'
  | 'ignored'
  | `group:${Exclude<GroupGuardOutcome, 'ignored'>}`;

export interface TelegramWebhookDeps {
  reply: (chatId: string, text: string) => Promise<unknown>;
  /** Site origin for links in replies, e.g. https://dreptalk.com */
  origin: string;
  now: number;
  /** The moderated group, absent when no group is configured for this deployment. */
  group?: { target: GroupGuardTarget; deps: GroupGuardDeps };
}

/**
 * Extracts text + chat id + label from an arbitrary update payload; null when the text
 * or chat id is missing, or the chat is not a private one to one chat with the bot. A
 * missing type is treated as not private, so group and channel updates never reach the
 * linking logic below. The label is the chat's @username, falling back to its first
 * name, or null when neither is present.
 */
function readMessage(update: unknown): { text: string; chatId: string; label: string | null } | null {
  if (typeof update !== 'object' || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const text = (message as { text?: unknown }).text;
  const chat = (message as { chat?: unknown }).chat;
  if (typeof text !== 'string' || typeof chat !== 'object' || chat === null) return null;
  const id = (chat as { id?: unknown }).id;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const type = (chat as { type?: unknown }).type;
  if (type !== 'private') return null;
  const username = (chat as { username?: unknown }).username;
  const firstName = (chat as { first_name?: unknown }).first_name;
  const label =
    typeof username === 'string' && username !== ''
      ? `@${username}`
      : typeof firstName === 'string' && firstName !== ''
        ? firstName
        : null;
  return { text, chatId: String(id), label };
}

/** Processes one update end to end, including the reply. Never throws on malformed input. */
export async function handleTelegramUpdate(
  db: D1Database,
  kv: KVNamespace,
  update: unknown,
  deps: TelegramWebhookDeps,
): Promise<TelegramWebhookOutcome> {
  // The guard decides itself whether an update is in its group; anything it
  // ignores falls through to the private-chat logic, which drops group chats.
  if (deps.group) {
    const outcome = await handleGroupUpdate(db, update, deps.group.target, deps.group.deps, deps.now);
    if (outcome !== 'ignored') return `group:${outcome}`;
  }
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
    await addChannel(db, { userId, channel: 'telegram', target: msg.chatId, endpoint, label: msg.label, now: deps.now });
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

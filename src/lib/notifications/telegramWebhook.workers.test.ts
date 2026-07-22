/// <reference types="@cloudflare/workers-types" />
// Webhook update handling against real D1 + KV in workerd. The reply sender is
// injected, so no Telegram traffic happens.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleTelegramUpdate, type TelegramWebhookDeps } from './telegramWebhook.js';
import { issueLinkCode } from './telegramLink.js';
import { listChannels, addChannel } from '../db/notificationChannels.js';

const db = () => env.DB;
const kv = () => (env as { SESSIONS: KVNamespace }).SESSIONS;

function fakeReply() {
  const calls: Array<{ chatId: string; text: string }> = [];
  return { calls, reply: async (chatId: string, text: string) => { calls.push({ chatId, text }); } };
}

const deps = (reply: TelegramWebhookDeps['reply']): TelegramWebhookDeps => ({
  reply,
  origin: 'https://dreptalk.com',
  now: 1_000,
});

const startUpdate = (code: string, chatId = 777) => ({
  message: { text: `/start ${code}`, chat: { id: chatId, type: 'private' } },
});

describe('handleTelegramUpdate', () => {
  it('links a valid /start code: channel row + connected reply', async () => {
    const code = await issueLinkCode(kv(), 'user-l1');
    const r = fakeReply();
    const update = {
      message: {
        text: `/start ${code}`,
        chat: { id: 777, type: 'private', username: 'ADAtainment', first_name: 'Ada' },
      },
    };
    const outcome = await handleTelegramUpdate(db(), kv(), update, deps(r.reply));
    expect(outcome).toBe('linked');
    const rows = await listChannels(db(), 'user-l1');
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('telegram');
    expect(rows[0].endpoint).toBe('telegram:777');
    expect(rows[0].target).toBe('777');
    expect(rows[0].label).toBe('@ADAtainment');
    expect(r.calls[0].chatId).toBe('777');
    expect(r.calls[0].text).toContain('Connected');
  });

  it('links with a first name when the chat has no username', async () => {
    const code = await issueLinkCode(kv(), 'user-l5');
    const r = fakeReply();
    const update = {
      message: { text: `/start ${code}`, chat: { id: 111, type: 'private', first_name: 'Ada' } },
    };
    await handleTelegramUpdate(db(), kv(), update, deps(r.reply));
    const rows = await listChannels(db(), 'user-l5');
    expect(rows[0].label).toBe('Ada');
  });

  it('links with a null label when the chat has neither username nor first name', async () => {
    const code = await issueLinkCode(kv(), 'user-l6');
    const r = fakeReply();
    const update = { message: { text: `/start ${code}`, chat: { id: 222, type: 'private' } } };
    await handleTelegramUpdate(db(), kv(), update, deps(r.reply));
    const rows = await listChannels(db(), 'user-l6');
    expect(rows[0].label).toBeNull();
  });

  it('a repeat /start after the username changed refreshes the stored label', async () => {
    const a = await issueLinkCode(kv(), 'user-l7');
    const b = await issueLinkCode(kv(), 'user-l7');
    const r = fakeReply();
    const first = { message: { text: `/start ${a}`, chat: { id: 333, type: 'private', username: 'OldName' } } };
    const second = { message: { text: `/start ${b}`, chat: { id: 333, type: 'private', username: 'NewName' } } };
    await handleTelegramUpdate(db(), kv(), first, deps(r.reply));
    await handleTelegramUpdate(db(), kv(), second, deps(r.reply));
    const rows = await listChannels(db(), 'user-l7');
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('@NewName');
  });

  it('a /start with a valid code from a group chat is ignored and does not burn the code', async () => {
    const code = await issueLinkCode(kv(), 'user-l4');
    const r = fakeReply();
    const groupUpdate = { message: { text: `/start ${code}`, chat: { id: 123, type: 'group' } } };
    const outcome = await handleTelegramUpdate(db(), kv(), groupUpdate, deps(r.reply));
    expect(outcome).toBe('ignored');
    expect(await listChannels(db(), 'user-l4')).toHaveLength(0);
    expect(r.calls).toHaveLength(0);

    // The code must still be valid for a follow-up private /start.
    const followUp = await handleTelegramUpdate(db(), kv(), startUpdate(code, 456), deps(r.reply));
    expect(followUp).toBe('linked');
    expect(await listChannels(db(), 'user-l4')).toHaveLength(1);
  });

  it('repeat /start with a fresh code for the same chat stays one row', async () => {
    const a = await issueLinkCode(kv(), 'user-l2');
    const b = await issueLinkCode(kv(), 'user-l2');
    const r = fakeReply();
    await handleTelegramUpdate(db(), kv(), startUpdate(a, 888), deps(r.reply));
    await handleTelegramUpdate(db(), kv(), startUpdate(b, 888), deps(r.reply));
    expect(await listChannels(db(), 'user-l2')).toHaveLength(1);
  });

  it('an expired or unknown code replies with the expired hint', async () => {
    const r = fakeReply();
    const outcome = await handleTelegramUpdate(db(), kv(), startUpdate('bogus', 999), deps(r.reply));
    expect(outcome).toBe('link_invalid');
    expect(await listChannels(db(), 'bogus')).toHaveLength(0);
    expect(r.calls[0].text.toLowerCase()).toContain('expired');
  });

  it('/stop removes every channel row for the chat and confirms', async () => {
    await addChannel(db(), { userId: 'user-l3', channel: 'telegram', target: '555', endpoint: 'telegram:555', now: 1 });
    const r = fakeReply();
    const outcome = await handleTelegramUpdate(
      db(), kv(), { message: { text: '/stop', chat: { id: 555, type: 'private' } } }, deps(r.reply),
    );
    expect(outcome).toBe('stopped');
    expect(await listChannels(db(), 'user-l3')).toHaveLength(0);
    expect(r.calls[0].text).toContain('Disconnected');
  });

  it('any other text gets the help reply with the settings link', async () => {
    const r = fakeReply();
    const outcome = await handleTelegramUpdate(
      db(), kv(), { message: { text: 'hello?', chat: { id: 42, type: 'private' } } }, deps(r.reply),
    );
    expect(outcome).toBe('help');
    expect(r.calls[0].text).toContain('https://dreptalk.com/notifications/');
  });

  it('updates without a usable message/chat are ignored without replying', async () => {
    const r = fakeReply();
    expect(await handleTelegramUpdate(db(), kv(), {}, deps(r.reply))).toBe('ignored');
    expect(await handleTelegramUpdate(db(), kv(), { message: { chat: { id: 1 } } }, deps(r.reply))).toBe('ignored');
    expect(await handleTelegramUpdate(db(), kv(), { message: { text: '/start x' } }, deps(r.reply))).toBe('ignored');
    expect(r.calls).toHaveLength(0);
  });
});

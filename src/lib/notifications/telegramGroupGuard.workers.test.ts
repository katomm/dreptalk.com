/// <reference types="@cloudflare/workers-types" />
// Group guard against real KV in workerd. The Telegram calls are injected so
// no traffic happens; the tests assert on what would have been deleted or banned.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleGroupUpdate, GROUP_GUARD_DEFAULTS, type GroupGuardDeps } from './telegramGroupGuard.js';

const kv = () => (env as { SESSIONS: KVNamespace }).SESSIONS;
const GROUP = '-1001234';

function fakeTelegram() {
  const deleted: number[] = [];
  const banned: number[] = [];
  return {
    deleted,
    banned,
    deps: {
      deleteMessage: async (_chatId, messageId) => { deleted.push(messageId); return { ok: true, status: 200, description: '' }; },
      banChatMember: async (_chatId, userId) => { banned.push(userId); return { ok: true, status: 200, description: '' }; },
    } satisfies GroupGuardDeps,
  };
}

const cfg = GROUP_GUARD_DEFAULTS;
const bot = 'DRepTalkBot';
let nextId = 1;

const join = (users: Array<{ id: number; is_bot?: boolean }>, chatId = GROUP) => ({
  message: { message_id: nextId++, chat: { id: Number(chatId), type: 'supergroup' }, new_chat_members: users },
});
const msg = (userId: number, text: string, extra: Record<string, unknown> = {}, chatId = GROUP) => ({
  message: { message_id: nextId++, chat: { id: Number(chatId), type: 'supergroup' }, from: { id: userId }, text, ...extra },
});
const link = (userId: number, chatId = GROUP) =>
  msg(userId, 'claim t.me/free', { entities: [{ type: 'url', offset: 6, length: 10 }] }, chatId);

describe('handleGroupUpdate', () => {
  it('records a newcomer on join and deletes their first link message', async () => {
    const t = fakeTelegram();
    expect(await handleGroupUpdate(kv(), join([{ id: 10 }]), { chatId: GROUP, botUsername: bot, cfg }, t.deps)).toBe('joined');
    const u = link(10);
    expect(await handleGroupUpdate(kv(), u, { chatId: GROUP, botUsername: bot, cfg }, t.deps)).toBe('deleted');
    expect(t.deleted).toEqual([u.message.message_id]);
    expect(t.banned).toEqual([]);
  });

  it('bans on the second strike and forgets the account', async () => {
    const t = fakeTelegram();
    const g = { chatId: GROUP, botUsername: bot, cfg };
    await handleGroupUpdate(kv(), join([{ id: 11 }]), g, t.deps);
    await handleGroupUpdate(kv(), link(11), g, t.deps);
    expect(await handleGroupUpdate(kv(), link(11), g, t.deps)).toBe('banned');
    expect(t.deleted).toHaveLength(2);
    expect(t.banned).toEqual([11]);
    // After the ban the watch entry is gone: a later message is not judged.
    expect(await handleGroupUpdate(kv(), link(11), g, t.deps)).toBe('ignored');
  });

  it('releases a newcomer after enough clean messages', async () => {
    const t = fakeTelegram();
    const g = { chatId: GROUP, botUsername: bot, cfg };
    await handleGroupUpdate(kv(), join([{ id: 12 }]), g, t.deps);
    for (let i = 0; i < cfg.cleanMessages; i++) {
      expect(await handleGroupUpdate(kv(), msg(12, `hi ${i}`), g, t.deps)).toBe('clean');
    }
    expect(await handleGroupUpdate(kv(), link(12), g, t.deps)).toBe('ignored');
    expect(t.deleted).toEqual([]);
  });

  it('a clean message does not reset the strike count', async () => {
    const t = fakeTelegram();
    const g = { chatId: GROUP, botUsername: bot, cfg };
    await handleGroupUpdate(kv(), join([{ id: 13 }]), g, t.deps);
    await handleGroupUpdate(kv(), link(13), g, t.deps);
    await handleGroupUpdate(kv(), msg(13, 'sorry'), g, t.deps);
    expect(await handleGroupUpdate(kv(), link(13), g, t.deps)).toBe('banned');
  });

  it('leaves members who were never seen joining alone', async () => {
    const t = fakeTelegram();
    expect(await handleGroupUpdate(kv(), link(14), { chatId: GROUP, botUsername: bot, cfg }, t.deps)).toBe('ignored');
    expect(t.deleted).toEqual([]);
  });

  it('does not watch bots added by an admin', async () => {
    const t = fakeTelegram();
    const g = { chatId: GROUP, botUsername: bot, cfg };
    await handleGroupUpdate(kv(), join([{ id: 15, is_bot: true }]), g, t.deps);
    expect(await handleGroupUpdate(kv(), link(15), g, t.deps)).toBe('ignored');
  });

  it('ignores updates from any other group', async () => {
    const t = fakeTelegram();
    const g = { chatId: GROUP, botUsername: bot, cfg };
    expect(await handleGroupUpdate(kv(), join([{ id: 16 }], '-1009999'), g, t.deps)).toBe('ignored');
    expect(await handleGroupUpdate(kv(), link(16, '-1009999'), g, t.deps)).toBe('ignored');
    expect(t.deleted).toEqual([]);
  });

  it('judges edited messages the same way', async () => {
    const t = fakeTelegram();
    const g = { chatId: GROUP, botUsername: bot, cfg };
    await handleGroupUpdate(kv(), join([{ id: 17 }]), g, t.deps);
    const edited = { edited_message: link(17).message };
    expect(await handleGroupUpdate(kv(), edited, g, t.deps)).toBe('deleted');
    expect(t.deleted).toEqual([edited.edited_message.message_id]);
  });

  it('keeps going when Telegram refuses the delete', async () => {
    const g = { chatId: GROUP, botUsername: bot, cfg };
    const deps: GroupGuardDeps = {
      deleteMessage: async () => ({ ok: false, status: 400, description: 'Bad Request: not enough rights' }),
      banChatMember: async () => ({ ok: true, status: 200, description: '' }),
    };
    await handleGroupUpdate(kv(), join([{ id: 18 }]), g, deps);
    expect(await handleGroupUpdate(kv(), link(18), g, deps)).toBe('deleted');
    // The strike still counts, so the next one bans.
    expect(await handleGroupUpdate(kv(), link(18), g, deps)).toBe('banned');
  });
});

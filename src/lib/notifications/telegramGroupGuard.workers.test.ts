/// <reference types="@cloudflare/workers-types" />
// Group guard against real D1 in workerd. The Telegram calls are injected so
// no traffic happens; the tests assert on what would have been deleted or banned.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleGroupUpdate, GROUP_GUARD_DEFAULTS, type GroupGuardDeps } from './telegramGroupGuard.js';

const db = () => env.DB;
const GROUP = '-1001234';
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

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
const g = { chatId: GROUP, botUsername: 'DRepTalkBot', cfg };
let nextId = 1;

const join = (users: Array<{ id: number; is_bot?: boolean }>, chatId = GROUP) => ({
  message: { message_id: nextId++, chat: { id: Number(chatId), type: 'supergroup' }, new_chat_members: users },
});
const msg = (userId: number, text: string, extra: Record<string, unknown> = {}, chatId = GROUP) => ({
  message: { message_id: nextId++, chat: { id: Number(chatId), type: 'supergroup' }, from: { id: userId }, text, ...extra },
});
const link = (userId: number, chatId = GROUP) =>
  msg(userId, 'claim t.me/free', { entities: [{ type: 'url', offset: 6, length: 10 }] }, chatId);

const watchRow = (userId: number) =>
  db().prepare('SELECT expires_at, clean, strikes FROM telegram_group_watch WHERE chat_id = ? AND user_id = ?')
    .bind(GROUP, userId).first<{ expires_at: number; clean: number; strikes: number }>();

describe('handleGroupUpdate', () => {
  it('records a newcomer on join and deletes their first link message', async () => {
    const t = fakeTelegram();
    expect(await handleGroupUpdate(db(), join([{ id: 10 }]), g, t.deps, T0)).toBe('joined');
    const u = link(10);
    expect(await handleGroupUpdate(db(), u, g, t.deps, T0 + HOUR)).toBe('deleted');
    expect(t.deleted).toEqual([u.message.message_id]);
    expect(t.banned).toEqual([]);
  });

  it('bans on the second strike and forgets the account', async () => {
    const t = fakeTelegram();
    await handleGroupUpdate(db(), join([{ id: 11 }]), g, t.deps, T0);
    await handleGroupUpdate(db(), link(11), g, t.deps, T0 + 1);
    expect(await handleGroupUpdate(db(), link(11), g, t.deps, T0 + 2)).toBe('banned');
    expect(t.deleted).toHaveLength(2);
    expect(t.banned).toEqual([11]);
    expect(await watchRow(11)).toBeNull();
    expect(await handleGroupUpdate(db(), link(11), g, t.deps, T0 + 3)).toBe('ignored');
  });

  it('two strikes arriving at the same time still add up to a ban', async () => {
    const t = fakeTelegram();
    await handleGroupUpdate(db(), join([{ id: 19 }]), g, t.deps, T0);
    const outcomes = await Promise.all([
      handleGroupUpdate(db(), link(19), g, t.deps, T0 + 1),
      handleGroupUpdate(db(), link(19), g, t.deps, T0 + 1),
    ]);
    expect(outcomes.sort()).toEqual(['banned', 'deleted']);
    expect(t.banned).toEqual([19]);
  });

  it('releases a newcomer after enough clean messages', async () => {
    const t = fakeTelegram();
    await handleGroupUpdate(db(), join([{ id: 12 }]), g, t.deps, T0);
    for (let i = 0; i < cfg.cleanMessages; i++) {
      expect(await handleGroupUpdate(db(), msg(12, `hi ${i}`), g, t.deps, T0 + i)).toBe('clean');
    }
    expect(await watchRow(12)).toBeNull();
    expect(await handleGroupUpdate(db(), link(12), g, t.deps, T0 + 10)).toBe('ignored');
    expect(t.deleted).toEqual([]);
  });

  it('a clean message does not reset the strike count', async () => {
    const t = fakeTelegram();
    await handleGroupUpdate(db(), join([{ id: 13 }]), g, t.deps, T0);
    await handleGroupUpdate(db(), link(13), g, t.deps, T0 + 1);
    await handleGroupUpdate(db(), msg(13, 'sorry'), g, t.deps, T0 + 2);
    expect(await handleGroupUpdate(db(), link(13), g, t.deps, T0 + 3)).toBe('banned');
  });

  it('the watch window is fixed at join and not extended by messages', async () => {
    const t = fakeTelegram();
    await handleGroupUpdate(db(), join([{ id: 20 }]), g, t.deps, T0);
    const before = (await watchRow(20))!.expires_at;
    expect(before).toBe(T0 + cfg.watchHours * HOUR);
    await handleGroupUpdate(db(), msg(20, 'hello'), g, t.deps, T0 + 23 * HOUR);
    expect((await watchRow(20))!.expires_at).toBe(before);
    // Past the window the account is no longer judged, even with a link.
    expect(await handleGroupUpdate(db(), link(20), g, t.deps, T0 + 25 * HOUR)).toBe('ignored');
    expect(t.deleted).toEqual([]);
  });

  it('a join sweeps expired rows', async () => {
    const t = fakeTelegram();
    await handleGroupUpdate(db(), join([{ id: 21 }]), g, t.deps, T0);
    await handleGroupUpdate(db(), join([{ id: 22 }]), g, t.deps, T0 + 30 * HOUR);
    expect(await watchRow(21)).toBeNull();
    expect(await watchRow(22)).not.toBeNull();
  });

  it('leaves members who were never seen joining alone', async () => {
    const t = fakeTelegram();
    expect(await handleGroupUpdate(db(), link(14), g, t.deps, T0)).toBe('ignored');
    expect(t.deleted).toEqual([]);
  });

  it('does not watch bots added by an admin', async () => {
    const t = fakeTelegram();
    expect(await handleGroupUpdate(db(), join([{ id: 15, is_bot: true }]), g, t.deps, T0)).toBe('ignored');
    expect(await handleGroupUpdate(db(), link(15), g, t.deps, T0 + 1)).toBe('ignored');
  });

  it('ignores updates from any other group', async () => {
    const t = fakeTelegram();
    expect(await handleGroupUpdate(db(), join([{ id: 16 }], '-1009999'), g, t.deps, T0)).toBe('ignored');
    expect(await handleGroupUpdate(db(), link(16, '-1009999'), g, t.deps, T0 + 1)).toBe('ignored');
    expect(t.deleted).toEqual([]);
  });

  it('judges edited messages but does not count them as clean messages', async () => {
    const t = fakeTelegram();
    await handleGroupUpdate(db(), join([{ id: 17 }]), g, t.deps, T0);
    const first = msg(17, 'hello');
    await handleGroupUpdate(db(), first, g, t.deps, T0 + 1);
    for (let i = 0; i < cfg.cleanMessages; i++) {
      const edit = { edited_message: { ...first.message, text: `hello ${i}` } };
      expect(await handleGroupUpdate(db(), edit, g, t.deps, T0 + 2 + i)).toBe('ignored');
    }
    expect((await watchRow(17))!.clean).toBe(1);
    const spamEdit = { edited_message: link(17).message };
    expect(await handleGroupUpdate(db(), spamEdit, g, t.deps, T0 + 10)).toBe('deleted');
    expect(t.deleted).toEqual([spamEdit.edited_message.message_id]);
  });

  it('keeps going when Telegram refuses the delete, the strike still counts', async () => {
    const deps: GroupGuardDeps = {
      deleteMessage: async () => ({ ok: false, status: 400, description: 'Bad Request: not enough rights' }),
      banChatMember: async () => ({ ok: true, status: 200, description: '' }),
    };
    await handleGroupUpdate(db(), join([{ id: 18 }]), g, deps, T0);
    expect(await handleGroupUpdate(db(), link(18), g, deps, T0 + 1)).toBe('deleted');
    expect(await handleGroupUpdate(db(), link(18), g, deps, T0 + 2)).toBe('banned');
  });

  it('keeps the watch when the ban fails, so the next message is still judged', async () => {
    let banOk = false;
    const deleted: number[] = [];
    const deps: GroupGuardDeps = {
      deleteMessage: async (_c, id) => { deleted.push(id); return { ok: true, status: 200, description: '' }; },
      banChatMember: async () => (banOk ? { ok: true, status: 200, description: '' } : { ok: false, status: 429, description: 'Too Many Requests' }),
    };
    await handleGroupUpdate(db(), join([{ id: 23 }]), g, deps, T0);
    await handleGroupUpdate(db(), link(23), g, deps, T0 + 1);
    expect(await handleGroupUpdate(db(), link(23), g, deps, T0 + 2)).toBe('deleted');
    expect(await watchRow(23)).not.toBeNull();
    banOk = true;
    expect(await handleGroupUpdate(db(), link(23), g, deps, T0 + 3)).toBe('banned');
    expect(deleted).toHaveLength(3);
    expect(await watchRow(23)).toBeNull();
  });
});

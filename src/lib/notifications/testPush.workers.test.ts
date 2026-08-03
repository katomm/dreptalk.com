/// <reference types="@cloudflare/workers-types" />
// Test-push flow tests: ownership scoping, delayed send payload, dead-target
// pruning. The push transport and the delay are injected.
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { sendTestPush, TEST_PUSH_DELAY_MS, sendTestTelegram } from './testPush.js';
import { addChannel, listChannels } from '../db/notificationChannels.js';
import type { VapidConfig } from '../push/webPush.js';
import type { TelegramSendResult } from '../push/telegram.js';

const db = () => env.DB;

const VAPID: VapidConfig = { publicKey: 'pub', privateKey: 'priv', subject: 'https://dreptalk.com' };
const TARGET = '{"endpoint":"https://push.example/dev1","keys":{"p256dh":"p","auth":"a"}}';

function deps(sendResult: { ok: boolean; status: number }) {
  const send = vi.fn().mockResolvedValue(sendResult);
  const sleep = vi.fn().mockResolvedValue(undefined);
  return { send, sleep };
}

describe('sendTestPush', () => {
  it('sends the test payload to an owned device after the delay', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: TARGET, endpoint: 'https://push.example/dev1', now: 1 });
    const d = deps({ ok: true, status: 201 });

    const outcome = await sendTestPush(db(), VAPID, { userId: 'alice', channelId: id }, d);

    expect(outcome).toBe('sent');
    expect(d.sleep).toHaveBeenCalledWith(TEST_PUSH_DELAY_MS);
    expect(d.send).toHaveBeenCalledTimes(1);
    const [target, payload, vapid] = d.send.mock.calls[0];
    expect(target.endpoint).toBe('https://push.example/dev1');
    expect(JSON.parse(payload)).toEqual({
      title: 'Test notification',
      body: 'Push is working on this device.',
      url: '/notifications/',
    });
    expect(vapid).toBe(VAPID);
  });

  it('refuses a channel owned by someone else without sending', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: TARGET, endpoint: 'https://push.example/dev1', now: 1 });
    const d = deps({ ok: true, status: 201 });

    const outcome = await sendTestPush(db(), VAPID, { userId: 'mallory', channelId: id }, d);

    expect(outcome).toBe('not_found');
    expect(d.send).not.toHaveBeenCalled();
  });

  it('prunes the channel when the subscription is dead (403 after a key rotation)', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: TARGET, endpoint: 'https://push.example/dev1', now: 1 });
    const d = deps({ ok: false, status: 403 });

    const outcome = await sendTestPush(db(), VAPID, { userId: 'alice', channelId: id }, d);

    expect(outcome).toBe('pruned');
    expect(await listChannels(db(), 'alice')).toHaveLength(0);
  });

  it('keeps the channel on a transient failure', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: TARGET, endpoint: 'https://push.example/dev1', now: 1 });
    const d = deps({ ok: false, status: 500 });

    const outcome = await sendTestPush(db(), VAPID, { userId: 'alice', channelId: id }, d);

    expect(outcome).toBe('failed');
    expect(await listChannels(db(), 'alice')).toHaveLength(1);
  });
});

function fakeTgSend(result: TelegramSendResult) {
  const calls: Array<{ chatId: string; text: string }> = [];
  const send: typeof import('../push/telegram.js').sendTelegramMessage = async (_token, chatId, text) => {
    calls.push({ chatId, text });
    return result;
  };
  return { send, calls };
}

describe('sendTestTelegram', () => {
  it('sends immediately to an owned telegram channel', async () => {
    const id = await addChannel(db(), { userId: 'tt-1', channel: 'telegram', target: '900', endpoint: 'telegram:900', now: 1 });
    const { send, calls } = fakeTgSend({ ok: true, status: 200, description: '' });
    const outcome = await sendTestTelegram(db(), 'TOKEN', { userId: 'tt-1', channelId: id }, { send });
    expect(outcome).toBe('sent');
    expect(calls[0].chatId).toBe('900');
    expect(calls[0].text).toContain('Test notification');
  });

  it("rejects a channel the user does not own or that is not telegram", async () => {
    const otherId = await addChannel(db(), { userId: 'tt-2', channel: 'telegram', target: '901', endpoint: 'telegram:901', now: 1 });
    const { send } = fakeTgSend({ ok: true, status: 200, description: '' });
    expect(await sendTestTelegram(db(), 'TOKEN', { userId: 'someone-else', channelId: otherId }, { send })).toBe('not_found');
  });

  it('prunes a dead chat', async () => {
    const id = await addChannel(db(), { userId: 'tt-3', channel: 'telegram', target: '902', endpoint: 'telegram:902', now: 1 });
    const { send } = fakeTgSend({ ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' });
    expect(await sendTestTelegram(db(), 'TOKEN', { userId: 'tt-3', channelId: id }, { send })).toBe('pruned');
    expect(await listChannels(db(), 'tt-3')).toHaveLength(0);
  });
});

/// <reference types="@cloudflare/workers-types" />
// Test-push flow tests: ownership scoping, delayed send payload, dead-target
// pruning. The push transport and the delay are injected.
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { sendTestPush, TEST_PUSH_DELAY_MS } from './testPush.js';
import { addChannel, listChannels } from '../db/notificationChannels.js';
import type { VapidConfig } from '../push/webPush.js';

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
      title: 'DRepTalk test notification',
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

/// <reference types="@cloudflare/workers-types" />
// Cron dispatcher tests, run in real workerd via vitest-pool-workers. `send`
// is injected as a fake so no real network call happens; the crypto and HTTP
// transport are covered separately by webPush.workers.test.ts.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { dispatchWebPush, dispatchTelegram, type DispatchDeps, type TelegramDispatchConfig } from './dispatch.js';
import { addChannel, setPref, listChannelsByKind } from '../db/notificationChannels.js';
import { insertNotifications } from '../db/notifications.js';
import { activityInsert } from '../db/activity.js';
import type { PushSendResult, PushSubscriptionTarget, VapidConfig } from '../push/webPush.js';
import type { TelegramSendResult } from '../push/telegram.js';

const db = () => env.DB;

const VAPID: VapidConfig = { publicKey: 'pub', privateKey: 'priv', subject: 'https://dreptalk.com' };

const TARGET: PushSubscriptionTarget = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };

async function seedTopic(id: string) {
  await db()
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, deleted, last_post_at, created_at)
       VALUES (?, 'governance', 'gov-sync', 'governance', 't', ?, 0, 0, 0)`,
    )
    .bind(id, `${id}-slug`)
    .run();
}

// A users row is needed for the payload's `badge` (getUnreadCount reads
// notif_seen_at, which is 0 here so every gov thread counts); without it the
// gov term compares against a NULL cursor and contributes nothing.
async function seedUser(id: string) {
  await db()
    .prepare('INSERT INTO users (id, created_at, last_verified_at) VALUES (?, 0, 0)')
    .bind(id)
    .run();
}

/** A fake `send` that records every call and always returns the given result. */
function fakeSend(result: PushSendResult) {
  const calls: Array<{ target: PushSubscriptionTarget; payload: string; vapid: VapidConfig }> = [];
  const send: typeof import('../push/webPush.js').sendWebPush = async (target, payload, vapid) => {
    calls.push({ target, payload, vapid });
    return result;
  };
  return { send, calls };
}

async function addWebpushChannel(userId: string, now: number) {
  return addChannel(db(), {
    userId,
    channel: 'webpush',
    target: JSON.stringify(TARGET),
    endpoint: TARGET.endpoint,
    now,
  });
}

const TG_CFG: TelegramDispatchConfig = { botToken: 'TOKEN', origin: 'https://dreptalk.com' };

/** A fake `send` that records every call and always returns the given result. */
function fakeTelegramSend(result: TelegramSendResult) {
  const calls: Array<{ botToken: string; chatId: string; text: string }> = [];
  const send: typeof import('../push/telegram.js').sendTelegramMessage = async (botToken, chatId, text) => {
    calls.push({ botToken, chatId, text });
    return result;
  };
  return { send, calls };
}

async function addTelegramChannel(userId: string, chatId: string, now: number) {
  return addChannel(db(), {
    userId,
    channel: 'telegram',
    target: chatId,
    endpoint: `telegram:${chatId}`,
    now,
  });
}

describe('dispatchWebPush', () => {
  it('bundles pending counts into one send per channel with the exact summary text', async () => {
    await seedUser('alice');
    await seedTopic('g1');
    await seedTopic('g2');
    await seedTopic('g3');
    const id = await addWebpushChannel('alice', 100);
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p2', createdAt: 210 },
      { recipientId: 'alice', type: 'mention', actorId: 'x', topicId: 't1', postId: 'p3', createdAt: 220 },
    ]);
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: 200 }).run();
    await activityInsert(db(), { type: 'gov_created', topicId: 'g2', actorId: null, createdAt: 200 }).run();
    await activityInsert(db(), { type: 'gov_created', topicId: 'g3', actorId: null, createdAt: 200 }).run();

    const { send, calls } = fakeSend({ ok: true, status: 201 });
    const deps: DispatchDeps = { send, now: 999 };

    const result = await dispatchWebPush(db(), VAPID, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toEqual(TARGET);
    expect(calls[0].vapid).toEqual(VAPID);
    expect(JSON.parse(calls[0].payload)).toEqual({
      title: 'DRepTalk',
      body: '2 new replies, 1 mention, 3 governance updates',
      url: '/notifications/',
      // Same tally as the header bell: 3 unread personal rows + 3 gov threads.
      badge: 6,
    });
    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0 });

    const [row] = await listChannelsByKind(db(), 'webpush');
    expect(row.id).toBe(id);
    expect(row.delivered_until).toBe(999);
  });

  it('carries the signed-in unread count as the app-icon badge', async () => {
    await seedUser('alice');
    await addWebpushChannel('alice', 100);
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
      { recipientId: 'alice', type: 'mention', actorId: 'x', topicId: 't1', postId: 'p2', createdAt: 210 },
    ]);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    await dispatchWebPush(db(), VAPID, { send, now: 999 });

    // Two unread personal rows, mirroring the header bell.
    expect(JSON.parse(calls[0].payload).badge).toBe(2);
  });

  it('skips a channel with zero pending notifications, advancing nothing and never calling send', async () => {
    await addWebpushChannel('alice', 100);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, { send, now: 999 });

    expect(calls).toHaveLength(0);
    expect(result).toEqual({ sent: 0, pruned: 0, skipped: 1 });
    const [row] = await listChannelsByKind(db(), 'webpush');
    expect(row.delivered_until).toBe(100);
  });

  it('prunes the channel row on a 410 Gone response', async () => {
    const id = await addWebpushChannel('alice', 100);
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
    ]);
    const { send } = fakeSend({ ok: false, status: 410 });

    const result = await dispatchWebPush(db(), VAPID, { send, now: 999 });

    expect(result).toEqual({ sent: 0, pruned: 1, skipped: 0 });
    const rows = await listChannelsByKind(db(), 'webpush');
    expect(rows.find((r) => r.id === id)).toBeUndefined();
  });

  it('prunes the channel row on a 403 response (subscription bound to another VAPID key)', async () => {
    await addWebpushChannel('alice', 100);
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
    ]);
    const { send } = fakeSend({ ok: false, status: 403 });

    const result = await dispatchWebPush(db(), VAPID, { send, now: 999 });

    expect(result).toEqual({ sent: 0, pruned: 1, skipped: 0 });
    expect(await listChannelsByKind(db(), 'webpush')).toHaveLength(0);
  });

  it('prunes the channel row on a 404 response too', async () => {
    await addWebpushChannel('alice', 100);
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
    ]);
    const { send } = fakeSend({ ok: false, status: 404 });

    const result = await dispatchWebPush(db(), VAPID, { send, now: 999 });

    expect(result).toEqual({ sent: 0, pruned: 1, skipped: 0 });
    expect(await listChannelsByKind(db(), 'webpush')).toHaveLength(0);
  });

  it('leaves the cursor untouched on a 500, and a second dispatch call retries the send', async () => {
    await addWebpushChannel('alice', 100);
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
    ]);
    const { send, calls } = fakeSend({ ok: false, status: 500 });

    const first = await dispatchWebPush(db(), VAPID, { send, now: 999 });
    expect(first).toEqual({ sent: 0, pruned: 0, skipped: 0 });
    const [row] = await listChannelsByKind(db(), 'webpush');
    expect(row.delivered_until).toBe(100); // cursor did not move

    const second = await dispatchWebPush(db(), VAPID, { send, now: 1500 });
    expect(second).toEqual({ sent: 0, pruned: 0, skipped: 0 });
    expect(calls).toHaveLength(2); // retried: same still-pending notification sent again
  });

  it('excludes a prefs-disabled event type from both the counts and the summary text', async () => {
    await addWebpushChannel('alice', 100);
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'mention', enabled: false });
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
      { recipientId: 'alice', type: 'mention', actorId: 'x', topicId: 't1', postId: 'p2', createdAt: 210 },
    ]);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, { send, now: 999 });

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0 });
    expect(JSON.parse(calls[0].payload).body).toBe('1 new reply');
  });

  it('includes device pairings in the summary even when all prefs are off', async () => {
    await addWebpushChannel('alice', 100);
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'reply', enabled: false });
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'mention', enabled: false });
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'governance', enabled: false });
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'device_paired', actorId: null, topicId: null, postId: null, createdAt: 200 },
    ]);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, { send, now: 999 });

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0 });
    const body = JSON.parse(calls[0].payload).body as string;
    expect(body).toContain('device');
  });

  it('renders a phrase for each non-zero delegator term (drep activity, drep status, delegation change)', async () => {
    await addWebpushChannel('alice', 100);
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'delegator_drep_voted', actorId: null, topicId: null, postId: null, createdAt: 200 },
      { recipientId: 'alice', type: 'delegator_drep_re_voted', actorId: null, topicId: null, postId: null, createdAt: 210 },
      { recipientId: 'alice', type: 'delegator_drep_status_changed', actorId: null, topicId: null, postId: null, createdAt: 220 },
      { recipientId: 'alice', type: 'delegation_changed', actorId: null, topicId: null, postId: null, createdAt: 230 },
    ]);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, { send, now: 999 });

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0 });
    const body = JSON.parse(calls[0].payload).body as string;
    expect(body).toBe('2 DRep vote updates, 1 DRep status change, 1 delegation change');
  });

  it('spells out a single governance action with its title and a deep link', async () => {
    await seedUser('alice');
    await seedTopic('g1');
    await addWebpushChannel('alice', 100);
    await activityInsert(db(), {
      type: 'gov_created',
      topicId: 'g1',
      actorId: null,
      payload: { type: 'ParameterChange', title: 'Reduce committee size to 75' },
      createdAt: 200,
    }).run();
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, { send, now: 999 });

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0 });
    expect(JSON.parse(calls[0].payload)).toEqual({
      title: 'DRepTalk',
      body: 'New governance action: Reduce committee size to 75',
      url: '/t/g1-slug/',
      // One unseen gov thread, no personal rows.
      badge: 1,
    });
  });

  it('leads with the newest item and "(+N more)" for a small mixed bundle', async () => {
    await seedTopic('g1');
    await addWebpushChannel('alice', 100);
    // An older reply (counts, but not the lead) and a newer governance action.
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
    ]);
    await activityInsert(db(), {
      type: 'gov_created',
      topicId: 'g1',
      actorId: null,
      payload: { type: 'InfoAction', title: 'Ratify the budget' },
      createdAt: 300,
    }).run();
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    await dispatchWebPush(db(), VAPID, { send, now: 999 });

    const payload = JSON.parse(calls[0].payload);
    expect(payload.body).toBe('New governance action: Ratify the budget (+1 more)');
    expect(payload.url).toBe('/notifications/');
  });

  it('returns all-zero without calling send when vapid is null (unset secret)', async () => {
    await addWebpushChannel('alice', 100);
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
    ]);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), null, { send, now: 999 });

    expect(result).toEqual({ sent: 0, pruned: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
    const [row] = await listChannelsByKind(db(), 'webpush');
    expect(row.delivered_until).toBe(100);
  });
});

describe('dispatchTelegram', () => {
  it('sends one bundled message with summary and absolute link, then advances the cursor', async () => {
    const userId = 'tg-user-1';
    await addTelegramChannel(userId, '111', 0);
    await insertNotifications(db(), [
      { recipientId: userId, type: 'reply', actorId: 'a', topicId: null, postId: null, createdAt: 10 },
    ]);
    const { send, calls } = fakeTelegramSend({ ok: true, status: 200, description: '' });
    const r = await dispatchTelegram(db(), TG_CFG, { send, now: 50 });
    expect(r).toEqual({ sent: 1, pruned: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe('111');
    expect(calls[0].text).toBe('1 new reply\nhttps://dreptalk.com/notifications/');
    const [row] = await listChannelsByKind(db(), 'telegram');
    expect(row.delivered_until).toBe(50);
  });

  it('prunes the channel when the user blocked the bot (403)', async () => {
    const userId = 'tg-user-2';
    await addTelegramChannel(userId, '222', 0);
    await insertNotifications(db(), [
      { recipientId: userId, type: 'mention', actorId: 'a', topicId: null, postId: null, createdAt: 10 },
    ]);
    const { send } = fakeTelegramSend({ ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' });
    const r = await dispatchTelegram(db(), TG_CFG, { send, now: 50 });
    expect(r.pruned).toBe(1);
    const remaining = await listChannelsByKind(db(), 'telegram');
    expect(remaining.find((c) => c.target === '222')).toBeUndefined();
  });

  it('a transient failure leaves the cursor for a retry', async () => {
    const userId = 'tg-user-3';
    await addTelegramChannel(userId, '333', 0);
    await insertNotifications(db(), [
      { recipientId: userId, type: 'reply', actorId: 'a', topicId: null, postId: null, createdAt: 10 },
    ]);
    const { send } = fakeTelegramSend({ ok: false, status: 429, description: 'Too Many Requests' });
    const r = await dispatchTelegram(db(), TG_CFG, { send, now: 50 });
    expect(r).toEqual({ sent: 0, pruned: 0, skipped: 0 });
    const row = (await listChannelsByKind(db(), 'telegram')).find((c) => c.target === '333');
    expect(row?.delivered_until).toBe(0);
  });

  it('fails soft with a null config', async () => {
    const { send, calls } = fakeTelegramSend({ ok: true, status: 200, description: '' });
    const r = await dispatchTelegram(db(), null, { send, now: 50 });
    expect(r).toEqual({ sent: 0, pruned: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
  });

  it('does not touch webpush channels', async () => {
    const userId = 'tg-user-4';
    await addWebpushChannel(userId, 0);
    await insertNotifications(db(), [
      { recipientId: userId, type: 'reply', actorId: 'a', topicId: null, postId: null, createdAt: 10 },
    ]);
    const { send, calls } = fakeTelegramSend({ ok: true, status: 200, description: '' });
    await dispatchTelegram(db(), TG_CFG, { send, now: 50 });
    expect(calls).toHaveLength(0);
  });
});

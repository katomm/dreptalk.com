/// <reference types="@cloudflare/workers-types" />
// Cron dispatcher tests, run in real workerd via vitest-pool-workers. `send`
// is injected as a fake so no real network call happens; the crypto and HTTP
// transport are covered separately by webPush.workers.test.ts.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { dispatchWebPush, type DispatchDeps } from './dispatch.js';
import { addChannel, setPref, listChannelsByKind } from '../db/notificationChannels.js';
import { insertNotifications } from '../db/notifications.js';
import { activityInsert } from '../db/activity.js';
import type { PushSendResult, PushSubscriptionTarget, VapidConfig } from '../push/webPush.js';

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

describe('dispatchWebPush', () => {
  it('bundles pending counts into one send per channel with the exact summary text', async () => {
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
    });
    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0 });

    const [row] = await listChannelsByKind(db(), 'webpush');
    expect(row.id).toBe(id);
    expect(row.delivered_until).toBe(999);
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

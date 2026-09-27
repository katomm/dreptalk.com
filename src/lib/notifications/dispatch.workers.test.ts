/// <reference types="@cloudflare/workers-types" />
// Cron dispatcher tests, run in real workerd via vitest-pool-workers. `send`
// is injected as a fake so no real network call happens; the crypto and HTTP
// transport are covered separately by webPush.workers.test.ts.
//
// Producers stamp created_at / notified_at with the D1 clock, so most cases
// seed rows directly with fixed timestamps and pin the pass end through the
// `passEnd` test seam. The "real clock" case exercises the production path.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  dispatchWebPush,
  dispatchTelegram,
  DISPATCH_QUERIES_PER_CHANNEL_MAX,
  type DispatchDeps,
  type TelegramDispatchConfig,
} from './dispatch.js';
import { addChannel, setPref } from '../db/notificationChannels.js';
import { insertNotifications } from '../db/notifications.js';
import { activityInsert } from '../db/activity.js';
import { announceLatestEdition } from '../db/reviewAnnouncements.js';
import { UNLIMITED, allowance, countingDb } from '../sync/queryBudget.js';
import { afterDbMs } from '../db/__tests__/dbClock.js';
import { setChannelCursor, seedNotificationRow } from '../db/__tests__/notificationSeed.js';
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

async function addWebpushChannel(userId: string, cursor: number, endpoint = TARGET.endpoint) {
  const id = await addChannel(db(), {
    userId,
    channel: 'webpush',
    target: JSON.stringify({ ...TARGET, endpoint }),
    endpoint,
  });
  await setChannelCursor(db(), id, cursor);
  return id;
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

async function addTelegramChannel(userId: string, chatId: string, cursor: number) {
  const id = await addChannel(db(), { userId, channel: 'telegram', target: chatId, endpoint: `telegram:${chatId}` });
  await setChannelCursor(db(), id, cursor);
  return id;
}

/** A personal notification with a controlled created_at (producers stamp the D1 clock). */
async function seedPersonal(
  recipientId: string,
  type: string,
  createdAt: number,
  extra: { topicId?: string; postId?: string; actorId?: string; payload?: unknown } = {},
) {
  await seedNotificationRow(db(), { recipientId, type, createdAt, ...extra });
}

/** A governance thread event with a controlled notified_at. */
async function seedGov(
  topicId: string,
  notifiedAt: number,
  type: 'gov_created' | 'gov_status' = 'gov_created',
  payload: Record<string, unknown> = { type: 'InfoAction', title: 'T' },
) {
  await activityInsert(db(), { type, topicId, payload, createdAt: notifiedAt, notifiedAt }).run();
}

async function cursorOf(id: string) {
  return (await db()
    .prepare('SELECT delivered_until, dispatch_attempted_at, last_sent_at FROM notification_channels WHERE id = ?')
    .bind(id)
    .first<{ delivered_until: number; dispatch_attempted_at: number; last_sent_at: number | null }>())!;
}

async function channelsOf(kind: 'webpush' | 'telegram') {
  const { results } = await db()
    .prepare('SELECT id, target, delivered_until FROM notification_channels WHERE channel = ?')
    .bind(kind)
    .all<{ id: string; target: string; delivered_until: number }>();
  return results;
}

const deps = (send: DispatchDeps['send'], passEnd = 999): DispatchDeps => ({ send, allowance: UNLIMITED, passEnd });

describe('dispatchWebPush', () => {
  it('bundles pending counts into one send per channel with the exact summary text', async () => {
    await seedUser('alice');
    await seedTopic('g1');
    await seedTopic('g2');
    await seedTopic('g3');
    const id = await addWebpushChannel('alice', 100);
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p1' });
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p2' });
    await seedPersonal('alice', 'mention', 200, { actorId: 'x', topicId: 't1', postId: 'p3' });
    await seedGov('g1', 200);
    await seedGov('g2', 200);
    await seedGov('g3', 200);

    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toEqual(TARGET);
    expect(calls[0].vapid).toEqual(VAPID);
    expect(JSON.parse(calls[0].payload)).toEqual({
      // Six pending events, no single subject to name: the generic title.
      title: 'New activity',
      body: '2 new replies, 1 mention, 3 governance updates',
      url: '/notifications/',
      // Same tally as the header bell: 3 unread personal rows + 3 gov threads.
      badge: 6,
    });
    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0, deferred: false });

    const row = await cursorOf(id);
    expect(row.delivered_until).toBe(999);
    expect(row.dispatch_attempted_at).toBeGreaterThan(0);
    // A confirmed send stamps last_sent_at, distinct from the cursor: it is
    // what the settings page shows as "Last notified", never the muted advance.
    expect(row.last_sent_at).not.toBeNull();
  });

  it('carries the signed-in unread count as the app-icon badge', async () => {
    await seedUser('alice');
    await addWebpushChannel('alice', 100);
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p1' });
    await seedPersonal('alice', 'mention', 200, { actorId: 'x', topicId: 't1', postId: 'p2' });
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    await dispatchWebPush(db(), VAPID, deps(send, 999));

    // Two unread personal rows, mirroring the header bell.
    expect(JSON.parse(calls[0].payload).badge).toBe(2);
  });

  it('does not even select a channel with zero pending notifications', async () => {
    const id = await addWebpushChannel('alice', 100);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(calls).toHaveLength(0);
    expect(result).toEqual({ sent: 0, pruned: 0, skipped: 0, deferred: false });
    const row = await cursorOf(id);
    expect(row.delivered_until).toBe(100);
    expect(row.dispatch_attempted_at).toBe(0);
    expect(row.last_sent_at).toBeNull();
  });

  it('a muted pass advances the cursor but never sets last_sent_at', async () => {
    const id = await addWebpushChannel('alice', 100);
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'mention', enabled: false });
    await seedPersonal('alice', 'mention', 200); // only muted work pending
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(result).toEqual({ sent: 0, pruned: 0, skipped: 1, deferred: false });
    expect(calls).toHaveLength(0);
    const row = await cursorOf(id);
    // The cursor advanced past the muted row (rotation), but nothing was sent.
    expect(row.delivered_until).toBe(999);
    expect(row.last_sent_at).toBeNull();
  });

  it('prunes the channel row on a 410 Gone response', async () => {
    const id = await addWebpushChannel('alice', 100);
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p1' });
    const { send } = fakeSend({ ok: false, status: 410 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(result).toEqual({ sent: 0, pruned: 1, skipped: 0, deferred: false });
    const rows = await channelsOf('webpush');
    expect(rows.find((r) => r.id === id)).toBeUndefined();
  });

  it('prunes the channel row on a 403 response (subscription bound to another VAPID key)', async () => {
    await addWebpushChannel('alice', 100);
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p1' });
    const { send } = fakeSend({ ok: false, status: 403 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(result).toEqual({ sent: 0, pruned: 1, skipped: 0, deferred: false });
    expect(await channelsOf('webpush')).toHaveLength(0);
  });

  it('prunes the channel row on a 404 response too', async () => {
    await addWebpushChannel('alice', 100);
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p1' });
    const { send } = fakeSend({ ok: false, status: 404 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(result).toEqual({ sent: 0, pruned: 1, skipped: 0, deferred: false });
    expect(await channelsOf('webpush')).toHaveLength(0);
  });

  it('leaves the cursor untouched on a 500, and a second dispatch call retries the send', async () => {
    const id = await addWebpushChannel('alice', 100);
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p1' });
    const { send, calls } = fakeSend({ ok: false, status: 500 });

    const first = await dispatchWebPush(db(), VAPID, deps(send, 999));
    expect(first).toEqual({ sent: 0, pruned: 0, skipped: 0, deferred: false });
    expect((await cursorOf(id)).delivered_until).toBe(100); // cursor did not move
    expect((await cursorOf(id)).last_sent_at).toBeNull(); // a failed send never sets it

    const second = await dispatchWebPush(db(), VAPID, deps(send, 1500));
    expect(second).toEqual({ sent: 0, pruned: 0, skipped: 0, deferred: false });
    expect(calls).toHaveLength(2); // retried: same still-pending notification sent again
  });

  it('excludes a prefs-disabled event type from both the counts and the summary text', async () => {
    await addWebpushChannel('alice', 100);
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'mention', enabled: false });
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p1' });
    await seedPersonal('alice', 'mention', 200, { actorId: 'x', topicId: 't1', postId: 'p2' });
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0, deferred: false });
    expect(JSON.parse(calls[0].payload).body).toBe('1 new reply');
  });

  it('includes device pairings in the summary even when all prefs are off', async () => {
    await addWebpushChannel('alice', 100);
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'reply', enabled: false });
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'mention', enabled: false });
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'governance', enabled: false });
    await seedPersonal('alice', 'device_paired', 200);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0, deferred: false });
    const body = JSON.parse(calls[0].payload).body as string;
    expect(body).toContain('device');
  });

  it('puts a single governance action title in the push title, with a deep link', async () => {
    await seedUser('alice');
    await seedTopic('g1');
    await addWebpushChannel('alice', 100);
    await seedGov('g1', 200, 'gov_created', { type: 'ParameterChange', title: 'Reduce committee size to 75' });
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0, deferred: false });
    expect(JSON.parse(calls[0].payload)).toEqual({
      title: 'Reduce committee size to 75',
      body: 'New governance action',
      url: '/t/g1-slug/',
      // One unseen gov thread, no personal rows.
      badge: 1,
    });
  });

  it('names the cast choice in a single DRep-vote lead when the payload carries it', async () => {
    await seedUser('alice');
    await addWebpushChannel('alice', 100);
    await seedPersonal('alice', 'delegator_drep_voted', 200, {
      payload: { sourceTime: 150, gaId: 'gaX', title: 'Reduce fees', vote: 'Yes' },
    });
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0, deferred: false });
    const payload = JSON.parse(calls[0].payload);
    expect(payload.title).toBe('Reduce fees');
    expect(payload.body).toBe('Your DRep voted Yes');
  });

  it('leads with the newest item and "(+N more)" for a small mixed bundle', async () => {
    await seedTopic('g1');
    await addWebpushChannel('alice', 100);
    // An older reply (counts, but not the lead) and a newer governance action.
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p1' });
    await seedGov('g1', 300, 'gov_created', { type: 'InfoAction', title: 'Ratify the budget' });
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    await dispatchWebPush(db(), VAPID, deps(send, 999));

    const payload = JSON.parse(calls[0].payload);
    expect(payload.title).toBe('Ratify the budget');
    expect(payload.body).toBe('New governance action (+1 more)');
    expect(payload.url).toBe('/notifications/');
  });

  it('spells out a lone Governance Review announcement and links to the edition', async () => {
    await seedUser('alice');
    await addWebpushChannel('alice', 100);
    await announceLatestEdition(db(), { edition: 42, slug: 'epochs-653-655', title: 'Old' }, 0); // silent seed
    await announceLatestEdition(db(), { edition: 43, slug: 'epochs-656-658', title: 'The budget returns' }, 300);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    // The announcement row carries a D1-clock created_at, so the pass end sits above it.
    await dispatchWebPush(db(), VAPID, deps(send, Number.MAX_SAFE_INTEGER - 1));

    const payload = JSON.parse(calls[0].payload);
    expect(payload.title).toBe('The budget returns');
    expect(payload.body).toBe('New Governance Review, edition 43');
    expect(payload.url).toBe('/governance-review/epochs-656-658/');
  });

  it('sends nothing for a Governance Review announcement when its pref is off', async () => {
    await seedUser('alice');
    await addWebpushChannel('alice', 100);
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'governance_review', enabled: false });
    await announceLatestEdition(db(), { edition: 42, slug: 'epochs-653-655', title: 'Old' }, 0);
    await announceLatestEdition(db(), { edition: 43, slug: 'epochs-656-658', title: 'New' }, 300);
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, Number.MAX_SAFE_INTEGER - 1));

    expect(result).toEqual({ sent: 0, pruned: 0, skipped: 1, deferred: false });
    expect(calls).toHaveLength(0);
  });

  it('returns all-zero without calling send when vapid is null (unset secret)', async () => {
    const id = await addWebpushChannel('alice', 100);
    await seedPersonal('alice', 'reply', 200, { actorId: 'x', topicId: 't1', postId: 'p1' });
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), null, deps(send, 999));

    expect(result).toEqual({ sent: 0, pruned: 0, skipped: 0, deferred: false });
    expect(calls).toHaveLength(0);
    expect((await cursorOf(id)).delivered_until).toBe(100);
  });
});

describe('dispatchTelegram', () => {
  const tgDeps = (send: typeof import('../push/telegram.js').sendTelegramMessage, passEnd = 50) => ({
    send,
    allowance: UNLIMITED,
    passEnd,
  });

  it('sends one bundled message with summary and absolute link, then advances the cursor', async () => {
    const userId = 'tg-user-1';
    const id = await addTelegramChannel(userId, '111', 0);
    await seedPersonal(userId, 'reply', 20, { actorId: 'a' });
    const { send, calls } = fakeTelegramSend({ ok: true, status: 200, description: '' });
    const r = await dispatchTelegram(db(), TG_CFG, tgDeps(send));
    expect(r).toEqual({ sent: 1, pruned: 0, skipped: 0, deferred: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe('111');
    // Title line folded in ahead of the summary body, then the absolute link.
    expect(calls[0].text).toBe('New activity\n1 new reply\nhttps://dreptalk.com/notifications/');
    expect((await cursorOf(id)).delivered_until).toBe(50);
  });

  it('prunes the channel when the user blocked the bot (403)', async () => {
    const userId = 'tg-user-2';
    await addTelegramChannel(userId, '222', 0);
    await seedPersonal(userId, 'mention', 20, { actorId: 'a' });
    const { send } = fakeTelegramSend({ ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' });
    const r = await dispatchTelegram(db(), TG_CFG, tgDeps(send));
    expect(r.pruned).toBe(1);
    const remaining = await channelsOf('telegram');
    expect(remaining.find((c) => c.target === '222')).toBeUndefined();
  });

  it('a transient failure leaves the cursor for a retry', async () => {
    const userId = 'tg-user-3';
    const id = await addTelegramChannel(userId, '333', 0);
    await seedPersonal(userId, 'reply', 20, { actorId: 'a' });
    const { send } = fakeTelegramSend({ ok: false, status: 429, description: 'Too Many Requests' });
    const r = await dispatchTelegram(db(), TG_CFG, tgDeps(send));
    expect(r).toEqual({ sent: 0, pruned: 0, skipped: 0, deferred: false });
    expect((await cursorOf(id)).delivered_until).toBe(0);
  });

  it('fails soft with a null config', async () => {
    const { send, calls } = fakeTelegramSend({ ok: true, status: 200, description: '' });
    const r = await dispatchTelegram(db(), null, tgDeps(send));
    expect(r).toEqual({ sent: 0, pruned: 0, skipped: 0, deferred: false });
    expect(calls).toHaveLength(0);
  });

  it('does not touch webpush channels', async () => {
    const userId = 'tg-user-4';
    await addWebpushChannel(userId, 0);
    await seedPersonal(userId, 'reply', 20, { actorId: 'a' });
    const { send, calls } = fakeTelegramSend({ ok: true, status: 200, description: '' });
    await dispatchTelegram(db(), TG_CFG, tgDeps(send));
    expect(calls).toHaveLength(0);
  });
});

describe('dispatch pass interval and candidates', () => {
  it('only attempts up to the candidate limit and reports deferred', async () => {
    for (let i = 0; i < 5; i++) {
      await addWebpushChannel(`u${i}`, 100, `https://push.example/${i}`);
      await seedPersonal(`u${i}`, 'reply', 200);
    }
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    const { db: counted, meter } = countingDb(db());
    // Room for the two up-front queries plus exactly two worst-case channels.
    const a = allowance(meter, 2 + 2 * DISPATCH_QUERIES_PER_CHANNEL_MAX);
    const r = await dispatchWebPush(counted, VAPID, { send, allowance: a, passEnd: 999 });
    expect(calls.length).toBe(2);
    expect(r.deferred).toBe(true);
    expect(a.spent()).toBeLessThanOrEqual(2 + 2 * DISPATCH_QUERIES_PER_CHANNEL_MAX);
  });

  it('rotates: a second capped pass reaches the channels the first one skipped', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await addWebpushChannel(`u${i}`, 100, `https://push.example/${i}`));
      await seedPersonal(`u${i}`, 'reply', 200);
    }
    const { send } = fakeSend({ ok: true, status: 201 });
    const capTwo = () => {
      const { db: counted, meter } = countingDb(db());
      return { counted, a: allowance(meter, 2 + 2 * DISPATCH_QUERIES_PER_CHANNEL_MAX) };
    };
    let c = capTwo();
    await dispatchWebPush(c.counted, VAPID, { send, allowance: c.a, passEnd: 999 });
    for (let i = 0; i < 4; i++) await seedPersonal(`u${i}`, 'reply', 1500);
    c = capTwo();
    await dispatchWebPush(c.counted, VAPID, { send, allowance: c.a, passEnd: 1999 });
    const attempted = await Promise.all(ids.map(cursorOf));
    // Every channel was attempted exactly once across the two passes.
    expect(attempted.every((r) => r.dispatch_attempted_at > 0)).toBe(true);
  });

  it('with an allowance of 0 or 1 touches no table and reports deferred', async () => {
    await addWebpushChannel('u-zero', 100);
    await seedPersonal('u-zero', 'reply', 200);
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    for (const limit of [0, 1]) {
      const { db: counted, meter } = countingDb(db());
      const r = await dispatchWebPush(counted, VAPID, { send, allowance: allowance(meter, limit), passEnd: 999 });
      expect(r.deferred).toBe(true);
      expect(meter.used()).toBe(0);
    }
    expect(calls.length).toBe(0);
  });

  it('with room for exactly one channel serves one', async () => {
    await addWebpushChannel('u-one', 100);
    await seedPersonal('u-one', 'reply', 200);
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    const { db: counted, meter } = countingDb(db());
    await dispatchWebPush(counted, VAPID, {
      send,
      allowance: allowance(meter, 2 + DISPATCH_QUERIES_PER_CHANNEL_MAX),
      passEnd: 999,
    });
    expect(calls.length).toBe(1);
  });

  it('an unlimited allowance binds a finite candidate limit', async () => {
    await addWebpushChannel('u-inf', 100);
    await seedPersonal('u-inf', 'reply', 200);
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    const r = await dispatchWebPush(db(), VAPID, { send, allowance: UNLIMITED, passEnd: 999 });
    expect(calls.length).toBe(1);
    expect(r.deferred).toBe(false);
  });

  it('does not select a channel with nothing newer than its cursor', async () => {
    const id = await addWebpushChannel('u-idle', 500);
    await seedPersonal('u-idle', 'reply', 400);
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    await dispatchWebPush(db(), VAPID, deps(send));
    expect(calls.length).toBe(0);
    expect((await cursorOf(id)).dispatch_attempted_at).toBe(0);
  });

  it('a new governance thread makes every channel a candidate', async () => {
    await seedUser('ga');
    await seedUser('gb');
    await addWebpushChannel('ga', 100, 'https://push.example/ga');
    await addWebpushChannel('gb', 100, 'https://push.example/gb');
    await seedTopic('gt1');
    await seedGov('gt1', 300);
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    await dispatchWebPush(db(), VAPID, deps(send));
    expect(calls.length).toBe(2);
  });

  it('a failed send keeps the cursor but moves the channel to the back of the rotation', async () => {
    const id = await addWebpushChannel('u-fail', 100);
    await seedPersonal('u-fail', 'reply', 200);
    const { send } = fakeSend({ ok: false, status: 500 });
    await dispatchWebPush(db(), VAPID, deps(send));
    const r = await cursorOf(id);
    expect(r.delivered_until).toBe(100);
    expect(r.dispatch_attempted_at).toBeGreaterThan(0);
  });

  it('two devices of one user: the failing one is retried, the other is not re-sent', async () => {
    await seedUser('u-two');
    const ok = await addWebpushChannel('u-two', 100, 'https://push.example/ok');
    const bad = await addWebpushChannel('u-two', 100, 'https://push.example/bad');
    await seedPersonal('u-two', 'reply', 200);
    const calls: string[] = [];
    const send: DispatchDeps['send'] = async (target) => {
      calls.push(target.endpoint);
      return target.endpoint.endsWith('/bad') ? { ok: false, status: 500 } : { ok: true, status: 201 };
    };
    await dispatchWebPush(db(), VAPID, deps(send, 999));
    expect((await cursorOf(ok)).delivered_until).toBe(999);
    expect((await cursorOf(bad)).delivered_until).toBe(100);
    calls.length = 0;
    await dispatchWebPush(db(), VAPID, deps(send, 1999));
    expect(calls).toEqual(['https://push.example/bad']);
  });

  it('muted: advances past muted work without sending, and re-enabling later does not push it', async () => {
    await seedUser('u-mute');
    const id = await addWebpushChannel('u-mute', 100);
    await setPref(db(), { userId: 'u-mute', channel: 'webpush', eventType: 'reply', enabled: false });
    await seedPersonal('u-mute', 'reply', 200);
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    await dispatchWebPush(db(), VAPID, deps(send, 999));
    expect(calls.length).toBe(0);
    expect((await cursorOf(id)).delivered_until).toBe(999);
    await setPref(db(), { userId: 'u-mute', channel: 'webpush', eventType: 'reply', enabled: true });
    await dispatchWebPush(db(), VAPID, deps(send, 1999));
    expect(calls.length).toBe(0);
  });

  it('muted before any pass, re-enabled before the first pass: the event is pushed', async () => {
    await seedUser('u-re');
    await addWebpushChannel('u-re', 100);
    await setPref(db(), { userId: 'u-re', channel: 'webpush', eventType: 'reply', enabled: false });
    await seedPersonal('u-re', 'reply', 200);
    await setPref(db(), { userId: 'u-re', channel: 'webpush', eventType: 'reply', enabled: true });
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    await dispatchWebPush(db(), VAPID, deps(send, 999));
    expect(calls.length).toBe(1);
  });

  it('rows after passEnd are neither counted nor passed, and go out once on the next pass', async () => {
    await seedUser('u-late');
    const id = await addWebpushChannel('u-late', 100);
    await seedPersonal('u-late', 'reply', 200);
    await seedPersonal('u-late', 'mention', 1200); // written "during" the first pass
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    await dispatchWebPush(db(), VAPID, deps(send, 999));
    expect(calls.length).toBe(1);
    expect((await cursorOf(id)).delivered_until).toBe(999);
    await dispatchWebPush(db(), VAPID, deps(send, 1999));
    expect(calls.length).toBe(2);
    await dispatchWebPush(db(), VAPID, deps(send, 2999));
    expect(calls.length).toBe(2);
  });

  it('never moves a cursor backwards (channel connected after the pass started)', async () => {
    await seedUser('u-new');
    const id = await addWebpushChannel('u-new', 5000);
    await seedTopic('gt-new');
    await seedGov('gt-new', 6000); // makes it a candidate via the governance term
    const { send, calls } = fakeSend({ ok: true, status: 201 });
    await dispatchWebPush(db(), VAPID, deps(send, 999));
    expect(calls.length).toBe(0);
    expect((await cursorOf(id)).delivered_until).toBe(5000);
  });

  it('real clock: rows written between pass start and counts are excluded, then handled once', async () => {
    await seedUser('u-mid');
    await seedTopic('gt-mid');
    const id = await addChannel(db(), {
      userId: 'u-mid',
      channel: 'webpush',
      target: JSON.stringify(TARGET),
      endpoint: TARGET.endpoint,
    });
    await setPref(db(), { userId: 'u-mid', channel: 'webpush', eventType: 'mention', enabled: false });
    const { delivered_until: c0 } = await cursorOf(id);
    await afterDbMs(db(), c0);
    // One row before the pass, so the first pass has a bundle to send.
    await insertNotifications(db(), [{ recipientId: 'u-mid', type: 'reply', actorId: 'x', topicId: null, postId: null }]);
    const payloads: string[] = [];
    const send: DispatchDeps['send'] = async (_t, payload) => {
      payloads.push(payload);
      return { ok: true, status: 201 };
    };
    // Written after the pass start read: an enabled personal row, a governance
    // thread, and a muted row. None may be counted by this pass.
    const afterPassStart = async () => {
      await insertNotifications(db(), [{ recipientId: 'u-mid', type: 'reply', actorId: 'y', topicId: null, postId: null }]);
      await db().batch([
        activityInsert(db(), {
          type: 'gov_created',
          topicId: 'gt-mid',
          payload: { type: 'InfoAction', title: 'Mid' },
          createdAt: 1,
          notifiedAt: 'db-now',
        }),
      ]);
      await insertNotifications(db(), [{ recipientId: 'u-mid', type: 'mention', actorId: 'z', topicId: null, postId: null }]);
    };
    await afterDbMs(
      db(),
      (await db().prepare("SELECT MAX(created_at) AS m FROM notifications WHERE recipient_id = 'u-mid'").first<{ m: number }>())!.m,
    );
    await dispatchWebPush(db(), VAPID, { send, allowance: UNLIMITED, afterPassStart });
    expect(payloads.length).toBe(1);
    // The first bundle is exactly the one reply from before the pass: with no
    // topic on the seeded row the lead cannot resolve, so it falls to the
    // count-only summary. A leaked governance row or late reply in pass 1
    // would either change this exact text or make the lead resolve at all.
    expect(JSON.parse(payloads[0])).toMatchObject({ title: 'New activity', body: '1 new reply' });
    const passEndCursor = (await cursorOf(id)).delivered_until;
    const late = await db()
      .prepare("SELECT MIN(created_at) AS m FROM notifications WHERE recipient_id = 'u-mid' AND actor_id IN ('y', 'z')")
      .first<{ m: number }>();
    expect(passEndCursor).toBeLessThan(late!.m);
    // Second pass: the late reply and the governance thread go out once, the muted mention does not count.
    await afterDbMs(db(), (await db().prepare('SELECT MAX(created_at) AS m FROM notifications').first<{ m: number }>())!.m);
    await dispatchWebPush(db(), VAPID, { send, allowance: UNLIMITED });
    expect(payloads.length).toBe(2);
    await dispatchWebPush(db(), VAPID, { send, allowance: UNLIMITED });
    expect(payloads.length).toBe(2);
  });

  it('resolvePendingLead names the item inside the pass, never one past passEnd', async () => {
    await seedUser('u-lead');
    await seedTopic('t-lead-early');
    await seedTopic('t-lead-late');
    await addWebpushChannel('u-lead', 0);
    // Within the pass interval (<= 999): the item the lead must name.
    await seedPersonal('u-lead', 'reply', 200, { topicId: 't-lead-early', postId: 'p-early', actorId: 'actor-early' });
    // Past passEnd: written later in real time (a reply on a newer topic), must
    // not be picked even though it is the newer row overall.
    await seedPersonal('u-lead', 'reply', 1200, { topicId: 't-lead-late', postId: 'p-late', actorId: 'actor-late' });
    const { send, calls } = fakeSend({ ok: true, status: 201 });

    const result = await dispatchWebPush(db(), VAPID, deps(send, 999));

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 0, deferred: false });
    const payload = JSON.parse(calls[0].payload);
    expect(payload.url).toBe('/t/t-lead-early-slug/?tab=discussion#post-p-early');
    expect(payload.url).not.toContain('t-lead-late-slug');
    expect(payload.url).not.toContain('p-late');
  });
});

describe('DISPATCH_QUERIES_PER_CHANNEL_MAX', () => {
  it('covers the most expensive single-channel path', async () => {
    // Reply lead with a full author identity (user linked to a DRep and a pool, so
    // loadAuthorIdentities runs users, dreps and pools), webpush unread badge,
    // failed send with claim handback.
    await seedUser('u-cost');
    await seedUser('actor-cost');
    // Column names per src/lib/forum/author.ts (u.drep_id, u.pool_id). The drep and
    // pool rows only need to exist for the lookups to run.
    await db().prepare("UPDATE users SET drep_id = 'drep-cost', pool_id = 'pool-cost' WHERE id = 'actor-cost'").run();
    await seedTopic('t-cost');
    const channelId = await addWebpushChannel('u-cost', 100);
    await seedPersonal('u-cost', 'reply', 200, { topicId: 't-cost', postId: 'p-cost', actorId: 'actor-cost' });
    const { send } = fakeSend({ ok: false, status: 500 });
    const { db: counted, meter } = countingDb(db());
    const before = meter.used();
    await dispatchWebPush(counted, VAPID, { send, allowance: UNLIMITED, passEnd: 999 });
    const perChannel = meter.used() - before - 2; // minus pass start and candidate query
    // Pinned exactly, not just bounded: a silent increase here must fail this
    // test and prompt updating DISPATCH_QUERIES_PER_CHANNEL_MAX's comment too.
    expect(perChannel).toBe(11);
    expect(perChannel).toBeLessThanOrEqual(DISPATCH_QUERIES_PER_CHANNEL_MAX);
    // The failed send took the handback path: the cursor is back, the rotation stamp stays.
    const after = await cursorOf(channelId);
    expect(after.delivered_until).toBe(100);
    expect(after.dispatch_attempted_at).toBeGreaterThan(0);
  });
});

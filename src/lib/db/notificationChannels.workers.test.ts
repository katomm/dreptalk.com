/// <reference types="@cloudflare/workers-types" />
// Notification channel + prefs table access tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  addChannel,
  removeChannel,
  listChannels,
  listChannelsByKind,
  deleteChannelById,
  advanceCursor,
  getPrefs,
  setPref,
  getPendingCounts,
  type NotificationChannelRow,
} from './notificationChannels.js';
import { insertNotifications } from './notifications.js';
import { activityInsert } from './activity.js';

const db = () => env.DB;

// getPendingCounts's gov term joins activity to topics (live threads only),
// mirroring getUnreadCount's collapse, so referenced topics must exist.
async function seedTopic(id: string, opts?: { deleted?: boolean }) {
  await db()
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, deleted, last_post_at, created_at)
       VALUES (?, 'governance', 'gov-sync', 'governance', 't', ?, ?, 0, 0)`,
    )
    .bind(id, `${id}-slug`, opts?.deleted ? 1 : 0)
    .run();
}

const allEnabled = { reply: true, mention: true, governance: true };

describe('addChannel + listChannels + removeChannel', () => {
  it('seeds all-enabled prefs and returns a listable row', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-json', now: 100 });
    expect(typeof id).toBe('string');

    const rows = await listChannels(db(), 'alice');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      id,
      user_id: 'alice',
      channel: 'webpush',
      target: 'sub-json',
      created_at: 100,
      delivered_until: 100,
    });

    expect(await getPrefs(db(), 'alice', 'webpush')).toEqual(allEnabled);
  });

  it('lists channels by kind across users', async () => {
    await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', now: 1 });
    await addChannel(db(), { userId: 'bob', channel: 'webpush', target: 'sub-b', now: 2 });

    const rows = await listChannelsByKind(db(), 'webpush');
    expect(rows.map((r) => r.user_id).sort()).toEqual(['alice', 'bob']);
  });

  it('removeChannel is scoped to the owning user; another user is a no-op', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', now: 1 });

    await removeChannel(db(), 'bob', id);
    expect(await listChannels(db(), 'alice')).toHaveLength(1);

    await removeChannel(db(), 'alice', id);
    expect(await listChannels(db(), 'alice')).toHaveLength(0);
  });

  it('deleteChannelById removes regardless of owner (dispatcher prune)', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', now: 1 });

    await deleteChannelById(db(), id);
    expect(await listChannels(db(), 'alice')).toHaveLength(0);
  });
});

describe('advanceCursor', () => {
  it('moves the delivered_until cursor forward', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', now: 100 });

    await advanceCursor(db(), id, 500);

    const [row] = await listChannels(db(), 'alice');
    expect(row.delivered_until).toBe(500);
  });
});

describe('getPrefs + setPref', () => {
  it('defaults missing rows to true and reflects an explicit opt-out', async () => {
    await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', now: 1 });

    expect(await getPrefs(db(), 'alice', 'webpush')).toEqual(allEnabled);

    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'mention', enabled: false });
    expect(await getPrefs(db(), 'alice', 'webpush')).toEqual({ reply: true, mention: false, governance: true });

    // setPref is INSERT OR REPLACE: flipping back should stick too.
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'mention', enabled: true });
    expect(await getPrefs(db(), 'alice', 'webpush')).toEqual(allEnabled);
  });

  it('returns all-enabled defaults for a user/channel with no rows at all', async () => {
    expect(await getPrefs(db(), 'nobody', 'webpush')).toEqual(allEnabled);
  });
});

describe('getPendingCounts', () => {
  function row(overrides: Partial<NotificationChannelRow> = {}): NotificationChannelRow {
    return {
      id: 'chan1',
      user_id: 'alice',
      channel: 'webpush',
      target: 'sub-a',
      created_at: 0,
      delivered_until: 100,
      ...overrides,
    };
  }

  it('counts replies and mentions newer than the cursor, ignoring older rows', async () => {
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 50 }, // before cursor
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p2', createdAt: 200 },
      { recipientId: 'alice', type: 'mention', actorId: 'x', topicId: 't1', postId: 'p3', createdAt: 300 },
      { recipientId: 'bob', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p4', createdAt: 400 }, // other recipient
    ]);

    const counts = await getPendingCounts(db(), row(), allEnabled);
    expect(counts).toEqual({ replies: 1, mentions: 1, governance: 0, total: 2 });
  });

  it('zeroes a term whose pref is off', async () => {
    await insertNotifications(db(), [
      { recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 },
      { recipientId: 'alice', type: 'mention', actorId: 'x', topicId: 't1', postId: 'p2', createdAt: 300 },
    ]);

    const counts = await getPendingCounts(db(), row(), { reply: false, mention: true, governance: true });
    expect(counts).toEqual({ replies: 0, mentions: 1, governance: 0, total: 1 });
  });

  it('collapses two gov events on one topic to 1 and excludes deleted topics', async () => {
    await seedTopic('g1');
    await seedTopic('g2', { deleted: true });
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: 200 }).run();
    await activityInsert(db(), { type: 'gov_status', topicId: 'g1', actorId: null, payload: { from: 'active', to: 'ratified' }, createdAt: 300 }).run();
    await activityInsert(db(), { type: 'gov_created', topicId: 'g2', actorId: null, createdAt: 250 }).run();

    const counts = await getPendingCounts(db(), row(), allEnabled);
    expect(counts).toEqual({ replies: 0, mentions: 0, governance: 1, total: 1 });
  });

  it('zeroes the governance term when its pref is off', async () => {
    await seedTopic('g1');
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: 200 }).run();

    const counts = await getPendingCounts(db(), row(), { reply: true, mention: true, governance: false });
    expect(counts).toEqual({ replies: 0, mentions: 0, governance: 0, total: 0 });
  });

  it('respects the cursor for governance events too', async () => {
    await seedTopic('g1');
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: 50 }).run();

    const counts = await getPendingCounts(db(), row({ delivered_until: 100 }), allEnabled);
    expect(counts).toEqual({ replies: 0, mentions: 0, governance: 0, total: 0 });
  });
});

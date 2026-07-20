/// <reference types="@cloudflare/workers-types" />
// Notifications table access tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  insertNotifications,
  getNotificationsPage,
  getUnreadCount,
  getNotifSeenAt,
  markAllRead,
} from './notifications.js';
import { activityInsert } from './activity.js';

const db = () => env.DB;

async function seedUser(id: string) {
  await db()
    .prepare('INSERT INTO users (id, created_at, last_verified_at) VALUES (?, ?, ?)')
    .bind(id, 1, 1)
    .run();
}

function insert(recipientId: string, createdAt: number, type: 'reply' | 'mention' = 'reply') {
  return {
    recipientId,
    type,
    actorId: 'actor',
    topicId: 'topic1',
    postId: `post-${createdAt}`,
    createdAt,
  };
}

describe('insertNotifications + getNotificationsPage', () => {
  it('inserts rows and reads them back newest first, only for the recipient', async () => {
    await insertNotifications(db(), [insert('alice', 100), insert('alice', 200, 'mention'), insert('bob', 150)]);
    const page = await getNotificationsPage(db(), 'alice', 10);
    expect(page.map((r) => r.created_at)).toEqual([200, 100]);
    expect(page[0].type).toBe('mention');
    expect(page[0].read_at).toBeNull();
  });

  it('handles empty input and chunks past the 100-bind-param limit', async () => {
    await insertNotifications(db(), []);
    // 7 binds per row: 30 rows would exceed 100 binds in a single statement.
    const rows = Array.from({ length: 30 }, (_, i) => insert('carol', i + 1));
    await insertNotifications(db(), rows);
    const page = await getNotificationsPage(db(), 'carol', 50);
    expect(page.length).toBe(30);
  });
});

describe('getUnreadCount + markAllRead + getNotifSeenAt', () => {
  it('counts unread personal rows plus gov activity newer than notif_seen_at', async () => {
    await seedUser('alice');
    await insertNotifications(db(), [insert('alice', 100), insert('alice', 200)]);
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: 300 }).run();
    await activityInsert(db(), { type: 'reply_created', topicId: 'g1', actorId: 'x', refPostId: 'p', createdAt: 400 }).run();

    // 2 personal unread + 1 gov event (reply_created activity does not count).
    expect(await getUnreadCount(db(), 'alice')).toBe(3);

    await markAllRead(db(), 'alice', 500);
    expect(await getUnreadCount(db(), 'alice')).toBe(0);
    expect(await getNotifSeenAt(db(), 'alice')).toBe(500);

    // New gov event after the cursor counts again.
    await activityInsert(db(), { type: 'gov_status', topicId: 'g1', actorId: null, payload: { from: 'active', to: 'enacted' }, createdAt: 600 }).run();
    expect(await getUnreadCount(db(), 'alice')).toBe(1);
  });

  it('returns 0 for a user without a users row (defensive)', async () => {
    expect(await getUnreadCount(db(), 'ghost')).toBe(0);
  });
});

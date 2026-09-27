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
import { announceLatestEdition } from './reviewAnnouncements.js';
import { readDbNow } from './sql.js';
import { withDbClock, afterDbMs } from './__tests__/dbClock.js';

const db = () => env.DB;

async function seedUser(id: string) {
  await db()
    .prepare('INSERT INTO users (id, created_at, last_verified_at) VALUES (?, ?, ?)')
    .bind(id, 1, 1)
    .run();
}

// The gov term in getUnreadCount joins activity to topics (live threads only),
// mirroring getActivityPage's collapse, so referenced topics must exist.
async function seedTopic(id: string, opts?: { deleted?: boolean }) {
  await db()
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, deleted, last_post_at, created_at)
       VALUES (?, 'governance', 'gov-sync', 'governance', 't', ?, ?, 0, 0)`,
    )
    .bind(id, `${id}-slug`, opts?.deleted ? 1 : 0)
    .run();
}

/** Seeds a notification row with an explicit created_at, for the ordering test below, which checks a controlled time and cannot go through insertNotifications now that created_at comes from the database clock. */
async function seedNotification(recipientId: string, createdAt: number, type: 'reply' | 'mention' = 'reply') {
  await db()
    .prepare(
      `INSERT INTO notifications (id, recipient_id, type, actor_id, topic_id, post_id, created_at)
       VALUES (?, ?, ?, 'actor', 'topic1', ?, ?)`,
    )
    .bind(crypto.randomUUID(), recipientId, type, `post-${createdAt}`, createdAt)
    .run();
}

function insert(recipientId: string, type: 'reply' | 'mention' = 'reply') {
  return { recipientId, type, actorId: 'actor', topicId: 'topic1', postId: crypto.randomUUID() };
}

describe('insertNotifications + getNotificationsPage', () => {
  it('stamps created_at with the database clock', async () => {
    const { lo, hi } = await withDbClock(db(), () =>
      insertNotifications(db(), [
        { recipientId: 'u1', type: 'reply', actorId: 'a', topicId: 't', postId: 'p' },
      ]),
    );
    const row = await db()
      .prepare("SELECT created_at FROM notifications WHERE recipient_id = 'u1'")
      .first<{ created_at: number }>();
    expect(row!.created_at).toBeGreaterThanOrEqual(lo);
    expect(row!.created_at).toBeLessThanOrEqual(hi);
  });

  it('reads rows back newest first, only for the recipient', async () => {
    await seedNotification('alice', 100);
    await seedNotification('alice', 200, 'mention');
    await seedNotification('bob', 150);
    const page = await getNotificationsPage(db(), 'alice', 10);
    expect(page.map((r) => r.created_at)).toEqual([200, 100]);
    expect(page[0].type).toBe('mention');
    expect(page[0].read_at).toBeNull();
  });

  it('handles empty input and chunks past the 100-bind-param limit', async () => {
    await insertNotifications(db(), []);
    // 6 binds per row: 30 rows would exceed 100 binds in a single statement.
    const rows = Array.from({ length: 30 }, () => insert('carol'));
    await insertNotifications(db(), rows);
    const page = await getNotificationsPage(db(), 'carol', 50);
    expect(page.length).toBe(30);
  });
});

describe('markAllRead', () => {
  it('advances notif_seen_at with the database clock', async () => {
    await env.DB.prepare('INSERT INTO users (id, created_at, last_verified_at) VALUES (?, 0, 0)').bind('u-seen').run();
    const { lo, hi } = await withDbClock(env.DB, () => markAllRead(env.DB, 'u-seen'));
    const row = await env.DB.prepare('SELECT notif_seen_at FROM users WHERE id = ?')
      .bind('u-seen')
      .first<{ notif_seen_at: number }>();
    expect(row!.notif_seen_at).toBeGreaterThanOrEqual(lo);
    expect(row!.notif_seen_at).toBeLessThanOrEqual(hi);
  });
});

describe('getUnreadCount + markAllRead + getNotifSeenAt', () => {
  it('counts unread personal rows plus gov activity newer than notif_seen_at', async () => {
    await seedUser('alice');
    await seedTopic('g1');
    await insertNotifications(db(), [insert('alice'), insert('alice')]);
    const beforeMark = await readDbNow(db());
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: beforeMark, notifiedAt: beforeMark }).run();
    await activityInsert(db(), { type: 'reply_created', topicId: 'g1', actorId: 'x', refPostId: 'p', createdAt: beforeMark }).run();

    // 2 personal unread + 1 gov event (reply_created activity does not count).
    expect(await getUnreadCount(db(), 'alice')).toBe(3);

    const { lo, hi } = await withDbClock(db(), () => markAllRead(db(), 'alice'));
    expect(await getUnreadCount(db(), 'alice')).toBe(0);
    const seenAt = await getNotifSeenAt(db(), 'alice');
    expect(seenAt).toBeGreaterThanOrEqual(lo);
    expect(seenAt).toBeLessThanOrEqual(hi);

    // New gov event after the cursor counts again.
    await afterDbMs(db(), seenAt);
    const afterSeen = await readDbNow(db());
    await activityInsert(db(), {
      type: 'gov_status',
      topicId: 'g1',
      actorId: null,
      payload: { from: 'active', to: 'enacted' },
      createdAt: afterSeen,
      notifiedAt: afterSeen,
    }).run();
    expect(await getUnreadCount(db(), 'alice')).toBe(1);
  });

  it('counts a back-dated gov action by its detection time, not its epoch boundary', async () => {
    // Regression for migration 0067: a governance action is dated at its on-chain
    // epoch boundary (created_at), which can be days before discovery. With a
    // cursor between the submission and the discovery, the created_at comparison
    // treated the freshly discovered action as already seen and it never counted.
    await seedUser('grace');
    await seedTopic('g5');
    await db().prepare('UPDATE users SET notif_seen_at = 500 WHERE id = ?').bind('grace').run();
    // Submitted at 300 (before the cursor) but only discovered at 600 (after it).
    await activityInsert(db(), {
      type: 'gov_created',
      topicId: 'g5',
      actorId: null,
      createdAt: 300,
      notifiedAt: 600,
    }).run();

    expect(await getUnreadCount(db(), 'grace')).toBe(1);
  });

  it('returns 0 for a user without a users row (defensive)', async () => {
    expect(await getUnreadCount(db(), 'ghost')).toBe(0);
  });

  it('collapses two gov events on the same thread to one, matching the inbox', async () => {
    await seedUser('dave');
    await seedTopic('g2');
    await activityInsert(db(), { type: 'gov_created', topicId: 'g2', actorId: null, createdAt: 100 }).run();
    await activityInsert(db(), { type: 'gov_status', topicId: 'g2', actorId: null, payload: { from: 'active', to: 'ratified' }, createdAt: 200 }).run();

    // Two events, one thread: counts as 1 (DISTINCT topic_id), same as the collapsed inbox row.
    expect(await getUnreadCount(db(), 'dave')).toBe(1);
  });

  it('does not count gov events on a deleted topic', async () => {
    await seedUser('erin');
    await seedTopic('g3', { deleted: true });
    await activityInsert(db(), { type: 'gov_created', topicId: 'g3', actorId: null, createdAt: 100 }).run();

    expect(await getUnreadCount(db(), 'erin')).toBe(0);
  });

  it('still counts events newer than a zero notif_seen_at (unchanged SQL semantics)', async () => {
    await seedUser('frank');
    await seedTopic('g4');
    await activityInsert(db(), { type: 'gov_created', topicId: 'g4', actorId: null, createdAt: 1 }).run();

    // frank's notif_seen_at defaults to 0 (seedUser does not set it); any created_at > 0 counts.
    expect(await getUnreadCount(db(), 'frank')).toBe(1);
  });

  it('counts a Governance Review announcement newer than notif_seen_at, but not the seed', async () => {
    await seedUser('gina');
    await announceLatestEdition(db(), { edition: 42, slug: 'epochs-a', title: 'a' }, 0); // silent seed
    expect(await getUnreadCount(db(), 'gina')).toBe(0);
    await announceLatestEdition(db(), { edition: 43, slug: 'epochs-b', title: 'b' }, 500);
    expect(await getUnreadCount(db(), 'gina')).toBe(1);
    await markAllRead(db(), 'gina');
    expect(await getUnreadCount(db(), 'gina')).toBe(0);
  });
});

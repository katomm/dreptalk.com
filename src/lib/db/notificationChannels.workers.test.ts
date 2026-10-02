/// <reference types="@cloudflare/workers-types" />
// Notification channel + prefs table access tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  addChannel,
  removeChannel,
  listChannels,
  listDispatchCandidates,
  readPassStart,
  deleteChannelById,
  claimChannelCursor,
  handBackChannelCursor,
  markChannelSent,
  getPrefs,
  setPref,
  getPendingCounts,
  type NotificationChannelRow,
} from './notificationChannels.js';
import { activityInsert } from './activity.js';
import { announceLatestEdition } from './reviewAnnouncements.js';
import { readDbNow } from './sql.js';
import { withDbClock, afterDbMs } from './__tests__/dbClock.js';
import { setChannelCursor, seedNotificationRow as seedNotificationRowOn } from './__tests__/notificationSeed.js';

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

/** Binds the shared seeding helper to this file's db(), so call sites read the same as before. */
function seedNotificationRow(opts: Parameters<typeof seedNotificationRowOn>[1]) {
  return seedNotificationRowOn(db(), opts);
}

const allEnabled = {
  reply: true,
  mention: true,
  governance: true,
  drep_activity: true,
  drep_status: true,
  my_delegation: true,
  drep_stats: true,
  delegation_digest: true,
  rationale_ready: true,
  governance_review: true,
};

/** What a channel gets without stored choices: everything on except the opt-in epoch summary. */
const defaults = { ...allEnabled, delegation_digest: false };

describe('addChannel + listChannels + removeChannel', () => {
  it('seeds default prefs and returns a listable row, stamped with the database clock', async () => {
    const { result: id, lo, hi } = await withDbClock(db(), () =>
      addChannel(db(), {
        userId: 'alice',
        channel: 'webpush',
        target: 'sub-json',
        endpoint: 'https://push.example/alice',
      }),
    );
    expect(typeof id).toBe('string');

    const rows = await listChannels(db(), 'alice');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      id,
      user_id: 'alice',
      channel: 'webpush',
      target: 'sub-json',
      endpoint: 'https://push.example/alice',
    });
    expect(rows[0].created_at).toBeGreaterThanOrEqual(lo);
    expect(rows[0].created_at).toBeLessThanOrEqual(hi);
    expect(rows[0].delivered_until).toBeGreaterThanOrEqual(lo);
    expect(rows[0].delivered_until).toBeLessThanOrEqual(hi);

    expect(await getPrefs(db(), 'alice', 'webpush')).toEqual(defaults);
  });

  it('addChannel seeds delivered_until with the database clock', async () => {
    const { result: id, lo, hi } = await withDbClock(db(), () =>
      addChannel(db(), { userId: 'u-add', channel: 'webpush', target: '{}', endpoint: 'https://push.example/add' }),
    );
    const row = await db()
      .prepare('SELECT delivered_until FROM notification_channels WHERE id = ?')
      .bind(id)
      .first<{ delivered_until: number }>();
    expect(row!.delivered_until).toBeGreaterThanOrEqual(lo);
    expect(row!.delivered_until).toBeLessThanOrEqual(hi);
  });

  it('lists dispatch candidates of one kind across users, only those with a newer row', async () => {
    const a = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });
    const b = await addChannel(db(), { userId: 'bob', channel: 'webpush', target: 'sub-b', endpoint: 'https://push.example/b' });
    await addChannel(db(), { userId: 'carol', channel: 'webpush', target: 'sub-c', endpoint: 'https://push.example/c' });
    await addChannel(db(), { userId: 'alice', channel: 'telegram', target: '1', endpoint: 'telegram:1' });
    for (const id of [a, b]) await setChannelCursor(db(), id, 100);
    await seedNotificationRow({ recipientId: 'alice', type: 'reply', createdAt: 200 });
    await seedNotificationRow({ recipientId: 'bob', type: 'reply', createdAt: 200 });

    const rows = await listDispatchCandidates(db(), 'webpush', null, 10);
    expect(rows.map((r) => r.user_id).sort()).toEqual(['alice', 'bob']);
    expect(await listDispatchCandidates(db(), 'webpush', null, 0)).toEqual([]);
  });

  it('orders candidates least recently attempted first and applies the limit', async () => {
    const a = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });
    const b = await addChannel(db(), { userId: 'bob', channel: 'webpush', target: 'sub-b', endpoint: 'https://push.example/b' });
    await setChannelCursor(db(), a, 100);
    await setChannelCursor(db(), b, 100);
    // A governance event newer than both cursors makes both candidates.
    await claimChannelCursor(db(), a, 100, 100, 5000);

    const rows = await listDispatchCandidates(db(), 'webpush', 300, 1);
    expect(rows.map((r) => r.id)).toEqual([b]);
  });

  it('reads the pass start: the database clock and the newest live governance event', async () => {
    await seedTopic('g-live');
    await seedTopic('g-dead', { deleted: true });
    await activityInsert(db(), { type: 'gov_created', topicId: 'g-live', actorId: null, createdAt: 200 }).run();
    await activityInsert(db(), { type: 'gov_created', topicId: 'g-dead', actorId: null, createdAt: 900 }).run();
    const { result, lo, hi } = await withDbClock(db(), () => readPassStart(db()));
    expect(result.latestGovAt).toBe(200);
    expect(result.dbNow).toBeGreaterThanOrEqual(lo);
    expect(result.dbNow).toBeLessThanOrEqual(hi);
  });

  it('removeChannel is scoped to the owning user; another user is a no-op', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });

    await removeChannel(db(), 'bob', id);
    expect(await listChannels(db(), 'alice')).toHaveLength(1);

    await removeChannel(db(), 'alice', id);
    expect(await listChannels(db(), 'alice')).toHaveLength(0);
  });

  it('deleteChannelById removes regardless of owner (dispatcher prune)', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });

    await deleteChannelById(db(), id);
    expect(await listChannels(db(), 'alice')).toHaveLength(0);
  });

  it('a second addChannel for the same user and endpoint updates the existing row instead of duplicating it', async () => {
    const firstId = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-v1', endpoint: 'https://push.example/a' });
    const firstRow = await db()
      .prepare('SELECT delivered_until FROM notification_channels WHERE id = ?')
      .bind(firstId)
      .first<{ delivered_until: number }>();
    const secondId = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-v2', endpoint: 'https://push.example/a' });

    expect(secondId).toBe(firstId);
    const rows = await listChannels(db(), 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe('sub-v2');
    // The re-subscribe must not reset the delivery cursor: only the target
    // may change on conflict.
    expect(rows[0].delivered_until).toBe(firstRow!.delivered_until);
  });

  it('same user, different endpoints, creates two rows', async () => {
    await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });
    await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-b', endpoint: 'https://push.example/b' });

    expect(await listChannels(db(), 'alice')).toHaveLength(2);
  });

  it('different users, same endpoint, creates two rows', async () => {
    await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/shared' });
    await addChannel(db(), { userId: 'bob', channel: 'webpush', target: 'sub-b', endpoint: 'https://push.example/shared' });

    expect(await listChannels(db(), 'alice')).toHaveLength(1);
    expect(await listChannels(db(), 'bob')).toHaveLength(1);
  });
});

describe('setChannelCursor', () => {
  it('moves the delivered_until cursor forward', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });

    await setChannelCursor(db(), id, 500);

    const [row] = await listChannels(db(), 'alice');
    expect(row.delivered_until).toBe(500);
  });
});

describe('claimChannelCursor', () => {
  it('lets only the first of two claims on the same cursor value win', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });
    const seeded = await db()
      .prepare('SELECT delivered_until FROM notification_channels WHERE id = ?')
      .bind(id)
      .first<{ delivered_until: number }>();
    const cursor = seeded!.delivered_until;

    // Both overlapping runs read this delivered_until before either wrote.
    expect(await claimChannelCursor(db(), id, cursor, 500, 1)).toBe(true);
    expect(await claimChannelCursor(db(), id, cursor, 600, 2)).toBe(false);

    const [row] = await listChannels(db(), 'alice');
    expect(row.delivered_until).toBe(500);
    const stamp = await db()
      .prepare('SELECT dispatch_attempted_at FROM notification_channels WHERE id = ?')
      .bind(id)
      .first<{ dispatch_attempted_at: number }>();
    expect(stamp!.dispatch_attempted_at).toBe(1);
  });
});

describe('handBackChannelCursor', () => {
  it('restores the old value when the row still holds the claimed value', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });
    await setChannelCursor(db(), id, 100);
    await claimChannelCursor(db(), id, 100, 500, 1); // this pass claims 100 -> 500

    await handBackChannelCursor(db(), id, 500, 100); // the send failed, hand it back

    const [row] = await listChannels(db(), 'alice');
    expect(row.delivered_until).toBe(100);
  });

  it('does not rewind a cursor a later pass already moved past the claimed value', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });
    await setChannelCursor(db(), id, 100);
    // Slow pass A claims 100 -> 500.
    await claimChannelCursor(db(), id, 100, 500, 1);
    // Pass B, overlapping, claims the next bundle before A's handback runs.
    await claimChannelCursor(db(), id, 500, 900, 2);

    // A's send failed and it now hands its claim back, still thinking the row holds 500.
    await handBackChannelCursor(db(), id, 500, 100);

    const [row] = await listChannels(db(), 'alice');
    // Unchanged: rewinding to 100 would make B's already-sent bundle pending again.
    expect(row.delivered_until).toBe(900);
  });
});

describe('markChannelSent', () => {
  it('sets last_sent_at from the database clock', async () => {
    const id = await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });
    const { lo, hi } = await withDbClock(db(), () => markChannelSent(db(), id));
    const row = await db()
      .prepare('SELECT last_sent_at FROM notification_channels WHERE id = ?')
      .bind(id)
      .first<{ last_sent_at: number }>();
    expect(row!.last_sent_at).toBeGreaterThanOrEqual(lo);
    expect(row!.last_sent_at).toBeLessThanOrEqual(hi);
  });
});

describe('getPrefs + setPref', () => {
  it('defaults missing rows to the type default and reflects an explicit opt-out', async () => {
    await addChannel(db(), { userId: 'alice', channel: 'webpush', target: 'sub-a', endpoint: 'https://push.example/a' });

    expect(await getPrefs(db(), 'alice', 'webpush')).toEqual(defaults);

    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'mention', enabled: false });
    expect(await getPrefs(db(), 'alice', 'webpush')).toEqual({ ...defaults, mention: false });

    // setPref is INSERT OR REPLACE: flipping back should stick too.
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'mention', enabled: true });
    expect(await getPrefs(db(), 'alice', 'webpush')).toEqual(defaults);
  });

  it('returns the defaults for a user/channel with no rows at all', async () => {
    expect(await getPrefs(db(), 'nobody', 'webpush')).toEqual(defaults);
  });

  // Authorization-review checkpoint (delegator login, Phase 1): a delegator's
  // session carries only the fallback 'member' role, which the write-gated forum
  // handlers reject (see handlers.workers.test.ts). Managing one's own
  // notification prefs is a deliberate exception: this table has no role check
  // at all, and the API route (/api/notifications/prefs) only requires a signed-in
  // session, not a writer role. Proves a member can still set and read back a pref.
  it('allows a member to set their own notification pref', async () => {
    await setPref(db(), { userId: 'stake_test1deleg', channel: 'webpush', eventType: 'governance', enabled: false });
    const prefs = await getPrefs(db(), 'stake_test1deleg', 'webpush');
    expect(prefs.governance).toBe(false);
  });
});

describe('getPendingCounts', () => {
  // An open pass end, for the cases that are not about the upper bound.
  const OPEN = Number.MAX_SAFE_INTEGER;
  function row(overrides: Partial<NotificationChannelRow> = {}): NotificationChannelRow {
    return {
      id: 'chan1',
      user_id: 'alice',
      channel: 'webpush',
      target: 'sub-a',
      endpoint: 'https://push.example/a',
      created_at: 0,
      delivered_until: 100,
      ...overrides,
    };
  }

  it('counts replies and mentions newer than the cursor, ignoring older rows', async () => {
    await seedNotificationRow({ recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 50 }); // before cursor
    await seedNotificationRow({ recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p2', createdAt: 200 });
    await seedNotificationRow({ recipientId: 'alice', type: 'mention', actorId: 'x', topicId: 't1', postId: 'p3', createdAt: 300 });
    await seedNotificationRow({ recipientId: 'bob', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p4', createdAt: 400 }); // other recipient

    const counts = await getPendingCounts(db(), row(), allEnabled, OPEN);
    expect(counts).toEqual({
      replies: 1,
      mentions: 1,
      governance: 0,
      drepActivity: 0,
      drepStatus: 0,
      myDelegation: 0,
      drepStats: 0,
      delegationDigest: 0,
      rationaleReady: 0,
      reviews: 0,
      devices: 0,
      total: 2,
    });
  });

  it('bounds personal and governance terms by the pass end', async () => {
    await seedTopic('g1');
    await seedTopic('g2');
    await seedNotificationRow({ recipientId: 'alice', type: 'reply', createdAt: 200 });
    await seedNotificationRow({ recipientId: 'alice', type: 'reply', createdAt: 999 }); // exactly at the pass end
    await seedNotificationRow({ recipientId: 'alice', type: 'mention', createdAt: 1000 }); // after it
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: 300 }).run();
    await activityInsert(db(), { type: 'gov_created', topicId: 'g2', actorId: null, createdAt: 1000 }).run();

    const counts = await getPendingCounts(db(), row(), allEnabled, 999);
    expect(counts.replies).toBe(2);
    expect(counts.mentions).toBe(0);
    expect(counts.governance).toBe(1);
    expect(counts.total).toBe(3);
  });

  it('zeroes a term whose pref is off', async () => {
    await seedNotificationRow({ recipientId: 'alice', type: 'reply', actorId: 'x', topicId: 't1', postId: 'p1', createdAt: 200 });
    await seedNotificationRow({ recipientId: 'alice', type: 'mention', actorId: 'x', topicId: 't1', postId: 'p2', createdAt: 300 });

    const counts = await getPendingCounts(db(), row(), { ...allEnabled, reply: false }, OPEN);
    expect(counts).toEqual({
      replies: 0,
      mentions: 1,
      governance: 0,
      drepActivity: 0,
      drepStatus: 0,
      myDelegation: 0,
      drepStats: 0,
      delegationDigest: 0,
      rationaleReady: 0,
      reviews: 0,
      devices: 0,
      total: 1,
    });
  });

  it('collapses two gov events on one topic to 1 and excludes deleted topics', async () => {
    await seedTopic('g1');
    await seedTopic('g2', { deleted: true });
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: 200 }).run();
    await activityInsert(db(), { type: 'gov_status', topicId: 'g1', actorId: null, payload: { from: 'active', to: 'ratified' }, createdAt: 300 }).run();
    await activityInsert(db(), { type: 'gov_created', topicId: 'g2', actorId: null, createdAt: 250 }).run();

    const counts = await getPendingCounts(db(), row(), allEnabled, OPEN);
    expect(counts).toEqual({
      replies: 0,
      mentions: 0,
      governance: 1,
      drepActivity: 0,
      drepStatus: 0,
      myDelegation: 0,
      drepStats: 0,
      delegationDigest: 0,
      rationaleReady: 0,
      reviews: 0,
      devices: 0,
      total: 1,
    });
  });

  it('zeroes the governance term when its pref is off', async () => {
    await seedTopic('g1');
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: 200 }).run();

    const counts = await getPendingCounts(db(), row(), { ...allEnabled, governance: false }, OPEN);
    expect(counts).toEqual({
      replies: 0,
      mentions: 0,
      governance: 0,
      drepActivity: 0,
      drepStatus: 0,
      myDelegation: 0,
      drepStats: 0,
      delegationDigest: 0,
      rationaleReady: 0,
      reviews: 0,
      devices: 0,
      total: 0,
    });
  });

  it('respects the cursor for governance events too', async () => {
    await seedTopic('g1');
    await activityInsert(db(), { type: 'gov_created', topicId: 'g1', actorId: null, createdAt: 50 }).run();

    const counts = await getPendingCounts(db(), row({ delivered_until: 100 }), allEnabled, OPEN);
    expect(counts).toEqual({
      replies: 0,
      mentions: 0,
      governance: 0,
      drepActivity: 0,
      drepStatus: 0,
      myDelegation: 0,
      drepStats: 0,
      delegationDigest: 0,
      rationaleReady: 0,
      reviews: 0,
      devices: 0,
      total: 0,
    });
  });

  it('counts device_paired notifications regardless of prefs, unlike the other terms', async () => {
    await seedNotificationRow({ recipientId: 'alice', type: 'device_paired', createdAt: 200 });

    const counts = await getPendingCounts(db(), row(), {
      reply: false,
      mention: false,
      governance: false,
      drep_activity: false,
      drep_status: false,
      my_delegation: false,
      drep_stats: false,
    }, OPEN);
    expect(counts).toEqual({
      replies: 0,
      mentions: 0,
      governance: 0,
      drepActivity: 0,
      drepStatus: 0,
      myDelegation: 0,
      drepStats: 0,
      delegationDigest: 0,
      rationaleReady: 0,
      reviews: 0,
      devices: 1,
      total: 1,
    });
  });

  // Each delegator-facing type counts rows past the cursor into its own key and
  // drops to zero when its pref is off. drep_activity covers two notification types.
  it.each([
    { pref: 'drep_activity', key: 'drepActivity', types: ['delegator_drep_voted', 'delegator_drep_re_voted'] },
    { pref: 'drep_status', key: 'drepStatus', types: ['delegator_drep_status_changed'] },
    { pref: 'my_delegation', key: 'myDelegation', types: ['delegation_changed'] },
    { pref: 'delegation_digest', key: 'delegationDigest', types: ['delegation_digest'] },
    { pref: 'rationale_ready', key: 'rationaleReady', types: ['rationale_ready'] },
  ] as const)('counts $pref past the cursor, gated by its pref', async ({ pref, key, types }) => {
    for (const [i, type] of types.entries()) {
      await seedNotificationRow({ recipientId: 'alice', type, createdAt: 200 + i * 100 });
    }
    await seedNotificationRow({ recipientId: 'alice', type: types[0], createdAt: 50 }); // before cursor

    const enabledCounts = await getPendingCounts(db(), row(), allEnabled, OPEN);
    expect(enabledCounts[key]).toBe(types.length);
    expect(enabledCounts.total).toBe(types.length);

    const disabledCounts = await getPendingCounts(db(), row(), { ...allEnabled, [pref]: false }, OPEN);
    expect(disabledCounts[key]).toBe(0);
    expect(disabledCounts.total).toBe(0);
  });

  it('counts Governance Review announcements past the cursor, never the seed, gated by its pref', async () => {
    const ed = (edition: number) => ({ edition, slug: `epochs-${edition}`, title: `Edition ${edition}` });
    await db().prepare("INSERT INTO users (id, created_at, last_verified_at) VALUES ('alice', 1, 1)").run();
    await announceLatestEdition(db(), ed(42), 0); // silent seed, no notification
    await announceLatestEdition(db(), ed(43), 50); // before the channel's cursor
    const cursor = await readDbNow(db());
    await afterDbMs(db(), cursor);
    await announceLatestEdition(db(), ed(44), 200);

    const enabledCounts = await getPendingCounts(db(), row({ delivered_until: cursor }), allEnabled, OPEN);
    expect(enabledCounts.reviews).toBe(1);
    expect(enabledCounts.total).toBe(1);

    const disabledCounts = await getPendingCounts(db(), row({ delivered_until: cursor }), { ...allEnabled, governance_review: false }, OPEN);
    expect(disabledCounts.reviews).toBe(0);
    expect(disabledCounts.total).toBe(0);
  });
});

describe('migration 0113', () => {
  it('adds dispatch_attempted_at with default 0 and the rotation indexes', async () => {
    const id = await addChannel(db(), {
      userId: 'u-mig',
      channel: 'webpush',
      target: '{}',
      endpoint: 'https://push.example/mig',
    });
    const row = await db()
      .prepare('SELECT dispatch_attempted_at FROM notification_channels WHERE id = ?')
      .bind(id)
      .first<{ dispatch_attempted_at: number }>();
    expect(row?.dispatch_attempted_at).toBe(0);
    const lastSent = await db()
      .prepare('SELECT last_sent_at FROM notification_channels WHERE id = ?')
      .bind(id)
      .first<{ last_sent_at: number | null }>();
    expect(lastSent?.last_sent_at).toBeNull();
    const { results } = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?, ?, ?)")
      .bind('idx_notification_channels_dispatch', 'idx_notifications_created', 'idx_fanout_jobs_open_rotation',
        'idx_notification_channels_channel', 'idx_fanout_jobs_open')
      .all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual([
      'idx_fanout_jobs_open_rotation', 'idx_notification_channels_dispatch', 'idx_notifications_created',
    ]);
  });
});

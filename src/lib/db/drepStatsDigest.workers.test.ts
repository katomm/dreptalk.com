/// <reference types="@cloudflare/workers-types" />
// DRep stats digest evaluation, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { runDrepStatsDigest } from './drepStatsDigest.js';
import { insertVotingPowerHistory } from './drepVotingPowerHistory.js';
import { addChannel, getPendingCounts, getPrefs } from './notificationChannels.js';
import { resolvePendingLead } from '../notifications/pendingLead.js';

const db = () => env.DB as D1Database;

let seq = 0;
async function seedUser(drepId: string | null): Promise<string> {
  const id = `stats_user_${++seq}`;
  await db()
    .prepare(
      `INSERT INTO users (id, drep_id, is_drep, role, status, created_at, last_verified_at, notif_seen_at)
       VALUES (?, ?, ?, 'drep', 'active', 0, 0, 0)`,
    )
    .bind(id, drepId, drepId ? 1 : 0)
    .run();
  return id;
}

async function seedHistory(
  drepId: string,
  rows: { epoch: number; amount: string; count: number | null }[],
): Promise<void> {
  await insertVotingPowerHistory(
    db(),
    rows.map((r) => ({ drepId, epoch: r.epoch, amount: r.amount })),
  );
  for (const r of rows) {
    if (r.count === null) continue;
    await db()
      .prepare(
        'UPDATE drep_voting_power_history SET delegator_count = ? WHERE drep_id = ? AND epoch = ?',
      )
      .bind(r.count, drepId, r.epoch)
      .run();
  }
}

async function notificationsFor(userId: string) {
  return (
    (
      await db()
        .prepare(
          'SELECT type, event_key, payload, created_at FROM notifications WHERE recipient_id = ? ORDER BY created_at',
        )
        .bind(userId)
        .all<{ type: string; event_key: string; payload: string; created_at: number }>()
    ).results ?? []
  );
}

describe('runDrepStatsDigest', () => {
  it('notifies a firing DRep once, with a self-contained payload', async () => {
    const userId = await seedUser('drep_digest_a');
    await seedHistory('drep_digest_a', [
      { epoch: 800, amount: '100000000', count: 10 },
      { epoch: 801, amount: '105000000', count: 12 },
    ]);

    const r = await runDrepStatsDigest(db(), 801, 1_700_000_000_000);
    expect(r.fired).toBe(1);

    const rows = await notificationsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('drep_stats');
    expect(rows[0].event_key).toBe('drep_stats:drep_digest_a:801');
    expect(rows[0].created_at).toBe(1_700_000_000_000);
    expect(JSON.parse(rows[0].payload)).toEqual({
      epoch: 801,
      drepId: 'drep_digest_a',
      power: '105000000',
      powerPrev: '100000000',
      delegators: 12,
      delegatorsPrev: 10,
    });
  });

  it('is idempotent: a second pass for the same epoch inserts nothing', async () => {
    const userId = await seedUser('drep_digest_b');
    await seedHistory('drep_digest_b', [
      { epoch: 810, amount: '100000000', count: 10 },
      { epoch: 811, amount: '110000000', count: 10 },
    ]);

    const first = await runDrepStatsDigest(db(), 811, 1_700_000_000_000);
    const second = await runDrepStatsDigest(db(), 811, 1_700_000_100_000);
    expect(first.fired).toBe(1);
    expect(second.fired).toBe(0);
    expect(await notificationsFor(userId)).toHaveLength(1);
  });

  it('waits for the current epoch count instead of freezing a partial digest', async () => {
    const userId = await seedUser('drep_digest_wait');
    await seedHistory('drep_digest_wait', [
      { epoch: 870, amount: '100000000', count: 10 },
      { epoch: 871, amount: '110000000', count: null },
    ]);
    const first = await runDrepStatsDigest(db(), 871, 1_700_000_000_000);
    expect(first.fired).toBe(0);
    expect(await notificationsFor(userId)).toHaveLength(0);

    // A later pass stamps the count, the digest then fires complete. Without
    // the gate the first pass would have frozen a count-less digest forever
    // (the event_key blocks a second, richer notification).
    await db()
      .prepare(
        'UPDATE drep_voting_power_history SET delegator_count = 12 WHERE drep_id = ? AND epoch = ?',
      )
      .bind('drep_digest_wait', 871)
      .run();
    const second = await runDrepStatsDigest(db(), 871, 1_700_000_100_000);
    expect(second.fired).toBe(1);
    const rows = await notificationsFor(userId);
    expect(JSON.parse(rows[0].payload).delegators).toBe(12);
  });

  it('stays quiet below both thresholds', async () => {
    const userId = await seedUser('drep_digest_c');
    await seedHistory('drep_digest_c', [
      { epoch: 820, amount: '100000000000', count: 1000 },
      { epoch: 821, amount: '100500000000', count: 1005 },
    ]);
    const r = await runDrepStatsDigest(db(), 821, 1_700_000_000_000);
    expect(await notificationsFor(userId)).toHaveLength(0);
    expect(r.candidates).toBeGreaterThanOrEqual(1);
  });

  it('handles the launch epoch: no previous count, power still triggers', async () => {
    const userId = await seedUser('drep_digest_d');
    await seedHistory('drep_digest_d', [
      { epoch: 830, amount: '100000000', count: null },
      { epoch: 831, amount: '105000000', count: 12 },
    ]);
    const r = await runDrepStatsDigest(db(), 831, 1_700_000_000_000);
    expect(r.fired).toBe(1);
    const rows = await notificationsFor(userId);
    expect(JSON.parse(rows[0].payload).delegatorsPrev).toBeNull();
  });

  it('skips users without a drep_id and dreps without users', async () => {
    const plainUser = await seedUser(null);
    await seedHistory('drep_digest_nouser', [
      { epoch: 840, amount: '100000000', count: 1 },
      { epoch: 841, amount: '200000000', count: 5 },
    ]);
    await runDrepStatsDigest(db(), 841, 1_700_000_000_000);
    expect(await notificationsFor(plainUser)).toHaveLength(0);
    const all = (
      await db()
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE event_key LIKE 'drep_stats:drep_digest_nouser:%'")
        .first<{ n: number }>()
    );
    expect(all?.n).toBe(0);
  });

  it('notifies every account linked to the same drep', async () => {
    const u1 = await seedUser('drep_digest_multi');
    const u2 = await seedUser('drep_digest_multi');
    await seedHistory('drep_digest_multi', [
      { epoch: 850, amount: '100000000', count: 2 },
      { epoch: 851, amount: '100000000', count: 3 },
    ]);
    const r = await runDrepStatsDigest(db(), 851, 1_700_000_000_000);
    expect(r.fired).toBe(2);
    expect(await notificationsFor(u1)).toHaveLength(1);
    expect(await notificationsFor(u2)).toHaveLength(1);
  });

  it('feeds counts and a deep-linked lead to the dispatcher', async () => {
    const userId = await seedUser('drep_digest_lead');
    await seedHistory('drep_digest_lead', [
      { epoch: 860, amount: '100000000000000', count: 100 },
      { epoch: 861, amount: '103000000000000', count: 102 },
    ]);

    // Channel FIRST: addChannel seeds delivered_until with its `now`, so the
    // cursor must predate the digest's created_at or the notification counts as
    // already delivered.
    const channelId = await addChannel(db(), {
      userId,
      channel: 'webpush',
      target: JSON.stringify({ endpoint: 'https://push.example/x', keys: {} }),
      endpoint: 'https://push.example/x',
      now: 1_699_999_999_000,
    });
    await runDrepStatsDigest(db(), 861, 1_700_000_000_000);

    const row = (await db()
      .prepare('SELECT * FROM notification_channels WHERE id = ?')
      .bind(channelId)
      .first()) as never;
    const prefs = await getPrefs(db(), userId, 'webpush');

    const counts = await getPendingCounts(db(), row, prefs);
    expect(counts.drepStats).toBe(1);

    const lead = await resolvePendingLead(db(), row, { ...prefs, governance: false });
    // Epoch rides in the title, the stat changes in the body.
    expect(lead?.title).toContain('Epoch 861');
    expect(lead?.body.toLowerCase()).toContain('voting power');
    // drepPath falls back to the raw id when no slug is passed: /dreps/<id>/.
    expect(lead?.href).toBe('/dreps/drep_digest_lead/');
  });
});

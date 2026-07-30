/// <reference types="@cloudflare/workers-types" />
// Fan-out worker tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { buildJobInsert, listOpenJobs, type FanoutJobInput } from '../db/fanoutJobs.js';
import { runFanout } from './fanout.js';
import { addChannel, getPendingCounts, getPrefs, listChannels } from '../db/notificationChannels.js';

const db = () => env.DB as D1Database;

function job(overrides: Partial<FanoutJobInput> = {}): FanoutJobInput {
  return {
    eventKey: 'drep-vote:drep1:ga1:100',
    eventType: 'delegator_drep_voted',
    subjectId: 'drep1',
    sourceTime: 100,
    payload: JSON.stringify({ gaId: 'ga1', vote: 'Yes', sourceTime: 100 }),
    createdAt: 100,
    ...overrides,
  };
}

async function insertFollow(
  userId: string,
  drepId: string,
  delegationSetAt: number,
  opts: { status?: string; type?: string } = {},
) {
  const status = opts.status ?? 'resolved';
  const pending = status === 'pending';
  const type = pending ? null : (opts.type ?? 'drep');
  await db()
    .prepare(
      `INSERT INTO delegator_follows
         (user_id, stake_addr, resolution_status, delegation_type, drep_id, checked_at, delegation_set_at, refresh_attempted_at, refresh_error_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      userId,
      `stake_${userId}`,
      status,
      type,
      pending ? null : type === 'drep' ? drepId : null,
      pending ? null : delegationSetAt,
      pending ? null : delegationSetAt,
      pending ? null : delegationSetAt,
    )
    .run();
}

async function notificationRows(eventKey: string) {
  const { results } = await db()
    .prepare('SELECT recipient_id, type, event_key, payload, created_at FROM notifications WHERE event_key = ?')
    .bind(eventKey)
    .all<{ recipient_id: string; type: string; event_key: string; payload: string; created_at: number }>();
  return results;
}

describe('runFanout', () => {
  it('materializes one notification per resolved follower whose delegation predates the event', async () => {
    await db().batch([buildJobInsert(db(), job())]);
    await insertFollow('user-a', 'drep1', 50);
    await insertFollow('user-b', 'drep1', 100);

    const now = 500;
    const result = await runFanout(db(), now);

    expect(result).toEqual({ jobs: 1, delivered: 2, completed: 1 });

    const rows = await notificationRows(job().eventKey);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recipient_id).sort()).toEqual(['user-a', 'user-b']);
    for (const row of rows) {
      expect(row.type).toBe('delegator_drep_voted');
      expect(JSON.parse(row.payload)).toMatchObject({ sourceTime: 100 });
    }

    const [openJob] = await listOpenJobs(db(), 10);
    expect(openJob).toBeUndefined();
  });

  // The delivery-cursor guarantee: created_at is the MATERIALIZATION time
  // (now * 1000, milliseconds), not the on-chain source_time. This is what
  // lets a push channel's delivered_until (advanced past source_time already,
  // e.g. from an earlier unrelated dispatch run) still see this notification
  // as pending once it lands. See the next test for the end-to-end regression
  // through getPendingCounts; here we assert the raw created_at value directly.
  it('sets created_at to materialization time (now * 1000), not source_time', async () => {
    await db().batch([buildJobInsert(db(), job({ sourceTime: 100 }))]);
    await insertFollow('user-a', 'drep1', 50);

    const deliveredUntil = 100 * 1000 + 5000; // already past source_time in ms
    const now = 900; // materialization happens well after source_time
    await runFanout(db(), now);

    const rows = await notificationRows(job().eventKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).toBe(now * 1000);
    expect(rows[0].created_at).toBeGreaterThan(deliveredUntil);
  });

  // The end-to-end version of the property asserted above: a channel whose
  // delivered_until cursor is already past the event's source_time (in ms)
  // must still see the fan-out notification as pending, because
  // getPendingCounts compares against created_at (materialization time), not
  // source_time. This proves Task 6's drepActivity term wiring is correct on
  // the actual data this worker produces, not just synthetic fixture rows.
  it('is counted by getPendingCounts under drepActivity, even though delivered_until is already past source_time', async () => {
    await db().batch([buildJobInsert(db(), job({ sourceTime: 100 }))]);
    await insertFollow('user-a', 'drep1', 50);

    const deliveredUntil = 100 * 1000 + 5000; // already past source_time in ms
    await addChannel(db(), {
      userId: 'user-a',
      channel: 'webpush',
      target: 'sub-a',
      endpoint: 'https://push.example/user-a',
      now: deliveredUntil,
    });

    const now = 900; // materialization happens well after source_time
    await runFanout(db(), now);

    const [row] = await listChannels(db(), 'user-a');
    const prefs = await getPrefs(db(), 'user-a', 'webpush');
    const counts = await getPendingCounts(db(), row, prefs);
    expect(counts.drepActivity).toBe(1);
    expect(counts.total).toBe(1);
  });

  it('does not notify a follower whose delegation was set after the event', async () => {
    await db().batch([buildJobInsert(db(), job({ sourceTime: 100 }))]);
    await insertFollow('user-late', 'drep1', 150); // set_at > source_time

    await runFanout(db(), 500);

    const rows = await notificationRows(job().eventKey);
    expect(rows).toHaveLength(0);
  });

  it('ignores unresolved or non-drep followers', async () => {
    await db().batch([buildJobInsert(db(), job())]);
    await insertFollow('user-pending', 'drep1', 50, { status: 'pending', type: 'drep' });
    await insertFollow('user-abstain', 'drep1', 50, { type: 'abstain' });

    await runFanout(db(), 500);

    const rows = await notificationRows(job().eventKey);
    expect(rows).toHaveLength(0);
  });

  it('is idempotent: running twice does not double-insert', async () => {
    await db().batch([buildJobInsert(db(), job())]);
    await insertFollow('user-a', 'drep1', 50);
    await insertFollow('user-b', 'drep1', 50);

    const first = await runFanout(db(), 500);
    expect(first.delivered).toBe(2);

    // Re-open the job to simulate a re-run over already-delivered recipients
    // (e.g. a retried pass before completion, or a manual re-drain). The
    // ON CONFLICT(recipient_id, event_key) guard must keep this a no-op.
    await db()
      .prepare('UPDATE notification_fanout_jobs SET completed_at = NULL, cursor_user_id = NULL WHERE event_key = ?')
      .bind(job().eventKey)
      .run();

    const second = await runFanout(db(), 600);
    expect(second.delivered).toBe(0);

    const rows = await notificationRows(job().eventKey);
    expect(rows).toHaveLength(2);
  });

  it('is fair: a mega job does not starve a small job within one pass', async () => {
    await db().batch([
      buildJobInsert(db(), job({ eventKey: 'mega', subjectId: 'drep-mega', sourceTime: 100, createdAt: 100 })),
      buildJobInsert(db(), job({ eventKey: 'small', subjectId: 'drep-small', sourceTime: 100, createdAt: 100 })),
    ]);
    for (let i = 0; i < 5; i++) {
      await insertFollow(`mega-user-${i}`, 'drep-mega', 50);
    }
    await insertFollow('small-user-0', 'drep-small', 50);

    // pageSize 2: the mega job needs 3 passes to drain (2+2+1), the small job
    // drains in its very first page. maxPasses: 1 forces a single pass so we
    // can assert both jobs made progress together, not mega-first-then-small.
    const result = await runFanout(db(), 500, { pageSize: 2, maxPasses: 1 });

    expect(result.jobs).toBe(2);
    // small job's single follower is delivered in the first (and only) page.
    const smallRows = await notificationRows('small');
    expect(smallRows).toHaveLength(1);
    // mega job only got its first page (2 of 5) in this one pass.
    const megaRows = await notificationRows('mega');
    expect(megaRows).toHaveLength(2);

    const openJobs = await listOpenJobs(db(), 10);
    // small is fully drained (page < pageSize) -> completed and gone from open jobs.
    expect(openJobs.map((j) => j.event_key)).toEqual(['mega']);
  });

  it('drains a mega job fully across multiple passes', async () => {
    await db().batch([buildJobInsert(db(), job({ eventKey: 'mega', subjectId: 'drep-mega', sourceTime: 100, createdAt: 100 }))]);
    for (let i = 0; i < 5; i++) {
      await insertFollow(`mega-user-${i}`, 'drep-mega', 50);
    }

    const result = await runFanout(db(), 500, { pageSize: 2 });

    expect(result.delivered).toBe(5);
    expect(result.completed).toBe(1);
    expect(await listOpenJobs(db(), 10)).toHaveLength(0);
  });
});

/// <reference types="@cloudflare/workers-types" />
// Fan-out worker tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { buildJobInsert, listOpenJobs, type FanoutJobInput } from '../db/fanoutJobs.js';
import { runFanout, fanoutPageCost } from './fanout.js';
import { addChannel, getPendingCounts, getPrefs, listChannels } from '../db/notificationChannels.js';
import { countingDb, allowance } from '../sync/queryBudget.js';
import { withDbClock, afterDbMs } from '../db/__tests__/dbClock.js';

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

    expect(result).toEqual({ jobs: 1, delivered: 2, completed: 1, deferred: false });

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

  // The delivery-cursor guarantee: created_at is stamped by the database
  // clock at insert time, not the on-chain source_time and not the drain's
  // start time. This is what lets a push channel's delivered_until (advanced
  // past source_time already, e.g. from an earlier unrelated dispatch run)
  // still see this notification as pending once it lands.
  it('stamps created_at with the database clock, not source_time', async () => {
    await insertFollow('u1', 'drep1', 50);
    await buildJobInsert(db(), job()).run();
    const { lo, hi } = await withDbClock(db(), () => runFanout(db(), 1000));
    const [row] = await notificationRows('drep-vote:drep1:ga1:100');
    expect(row.created_at).toBeGreaterThanOrEqual(lo);
    expect(row.created_at).toBeLessThanOrEqual(hi);
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

    await addChannel(db(), {
      userId: 'user-a',
      channel: 'webpush',
      target: 'sub-a',
      endpoint: 'https://push.example/user-a',
    });
    const [channelRow] = await listChannels(db(), 'user-a');
    // Both delivered_until (just above) and the fan-out insert's created_at
    // (below) are stamped by the database clock. Wait past the clock tick
    // that produced delivered_until first, so the strict created_at >
    // delivered_until comparison in getPendingCounts cannot tie on the same
    // millisecond.
    await afterDbMs(db(), channelRow.delivered_until);

    const now = 900; // materialization happens well after source_time
    await runFanout(db(), now);

    const [row] = await listChannels(db(), 'user-a');
    const prefs = await getPrefs(db(), 'user-a', 'webpush');
    const counts = await getPendingCounts(db(), row, prefs, Number.MAX_SAFE_INTEGER);
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
    // drains in its very first page. An allowance for exactly one job listing
    // and two pages forces the run to stop after a single pass, so we can
    // assert both jobs made progress together, not mega-first-then-small.
    // With 7 queries the loop lists both jobs, serves one page each, and then
    // cannot afford another listing.
    const { db: counted, meter } = countingDb(db());
    const result = await runFanout(counted, 500, { pageSize: 2, allowance: allowance(meter, 1 + 2 * fanoutPageCost(2)) });
    expect(result.deferred).toBe(true);

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

  it('stops at the allowance with jobs open, and the next run continues without duplicates', async () => {
    for (let i = 0; i < 5; i++) await insertFollow(`m${i}`, 'drep1', 50);
    await buildJobInsert(db(), job()).run();
    const page = 2;
    const { db: counted, meter } = countingDb(db());
    const first = await runFanout(counted, 1000, { pageSize: page, allowance: allowance(meter, 1 + fanoutPageCost(page)) });
    expect(first.deferred).toBe(true);
    expect((await notificationRows('drep-vote:drep1:ga1:100')).length).toBe(2);
    const second = await runFanout(db(), 1001, { pageSize: page });
    expect(second.deferred).toBe(false);
    expect((await notificationRows('drep-vote:drep1:ga1:100')).length).toBe(5);
  });

  it('rotates across runs: with more open jobs than the allowance covers, the left-out job goes next', async () => {
    await insertFollow('r1', 'drepA', 50);
    await insertFollow('r1b', 'drepA', 50);
    await insertFollow('r2', 'drepB', 50);
    await insertFollow('r2b', 'drepB', 50);
    await buildJobInsert(db(), job({ eventKey: 'a', subjectId: 'drepA', createdAt: 100 })).run();
    await buildJobInsert(db(), job({ eventKey: 'b', subjectId: 'drepB', createdAt: 100 })).run();
    const page = 1;
    const oneJobPerRun = () => {
      const { db: counted, meter } = countingDb(db());
      return { counted, a: allowance(meter, 1 + fanoutPageCost(page)) };
    };
    let r = oneJobPerRun();
    await runFanout(r.counted, 1000, { pageSize: page, allowance: r.a });
    r = oneJobPerRun();
    await runFanout(r.counted, 1001, { pageSize: page, allowance: r.a });
    expect((await notificationRows('a')).length).toBe(1);
    expect((await notificationRows('b')).length).toBe(1);
  });

  it('orders ties on updated_at by event_key', async () => {
    await buildJobInsert(db(), job({ eventKey: 'z', createdAt: 100 })).run();
    await buildJobInsert(db(), job({ eventKey: 'y', createdAt: 100 })).run();
    const open = await listOpenJobs(db(), 10);
    expect(open.map((j) => j.event_key)).toEqual(['y', 'z']);
  });

  it('completes a job with no followers in one page', async () => {
    await buildJobInsert(db(), job({ subjectId: 'drep-nobody' })).run();
    const { db: counted, meter } = countingDb(db());
    const r = await runFanout(counted, 1000, { allowance: allowance(meter, 100) });
    expect(r.completed).toBe(1);
    expect(meter.used()).toBeLessThanOrEqual(1 + fanoutPageCost(100) + 1);
    expect((await listOpenJobs(db(), 10)).length).toBe(0);
  });

  it('is not deferred when the allowance exactly covers the last job draining in one page', async () => {
    await insertFollow('u1', 'drep1', 50);
    await buildJobInsert(db(), job()).run();
    const page = 2;
    const { db: counted, meter } = countingDb(db());
    const r = await runFanout(counted, 1000, { pageSize: page, allowance: allowance(meter, 1 + fanoutPageCost(page)) });
    expect(r).toMatchObject({ completed: 1, deferred: false });
  });

  it('a page is atomic: a failing batch leaves no rows and no cursor step', async () => {
    for (let i = 0; i < 3; i++) await insertFollow(`x${i}`, 'drep1', 50);
    await buildJobInsert(db(), job()).run();
    // Force the page batch to fail by making the job row's cursor update violate a trigger.
    await db().prepare(
      `CREATE TRIGGER fail_cursor BEFORE UPDATE OF cursor_user_id ON notification_fanout_jobs
       BEGIN SELECT RAISE(ABORT, 'forced'); END`,
    ).run();
    await expect(runFanout(db(), 1000, { pageSize: 2 })).rejects.toThrow();
    await db().prepare('DROP TRIGGER fail_cursor').run();
    expect((await notificationRows('drep-vote:drep1:ga1:100')).length).toBe(0);
    const [open] = await listOpenJobs(db(), 10);
    expect(open.cursor_user_id).toBeNull();
  });
});

/// <reference types="@cloudflare/workers-types" />
// notification_fanout_jobs table access tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  buildJobInsert,
  listOpenJobs,
  buildAdvanceJobCursor,
  buildCompleteJob,
  type FanoutJobInput,
} from './fanoutJobs.js';

const db = () => env.DB;

function job(overrides: Partial<FanoutJobInput> = {}): FanoutJobInput {
  return {
    eventKey: 'drep-vote:drep1:ga1:100',
    eventType: 'delegator_drep_voted',
    subjectId: 'drep1',
    sourceTime: 100,
    payload: JSON.stringify({ gaId: 'ga1', vote: 'Yes' }),
    createdAt: 200,
    ...overrides,
  };
}

describe('buildJobInsert', () => {
  it('inserts a job row that listOpenJobs can read back', async () => {
    await db().batch([buildJobInsert(db(), job())]);

    const rows = await listOpenJobs(db(), 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_key: 'drep-vote:drep1:ga1:100',
      event_type: 'delegator_drep_voted',
      subject_id: 'drep1',
      source_time: 100,
      cursor_user_id: null,
      created_at: 200,
      updated_at: 200,
      completed_at: null,
    });
    expect(JSON.parse(rows[0].payload)).toEqual({ gaId: 'ga1', vote: 'Yes' });
  });

  it('is INSERT OR IGNORE: a duplicate event_key is a silent no-op, not an error', async () => {
    await db().batch([buildJobInsert(db(), job())]);
    // Second insert for the same event_key, with different fields, must not
    // error and must not overwrite or duplicate the row.
    await db().batch([buildJobInsert(db(), job({ subjectId: 'drep2', createdAt: 999 }))]);

    const rows = await listOpenJobs(db(), 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe('drep1');
    expect(rows[0].created_at).toBe(200);
  });

  it('can be batched alongside another statement atomically', async () => {
    await db().batch([
      buildJobInsert(db(), job()),
      buildJobInsert(db(), job({ eventKey: 'drep-vote:drep1:ga2:150', subjectId: 'drep1', sourceTime: 150 })),
    ]);

    const rows = await listOpenJobs(db(), 10);
    expect(rows).toHaveLength(2);
  });
});

describe('listOpenJobs', () => {
  it('returns only completed_at IS NULL rows, ordered by (updated_at, event_key)', async () => {
    await db().batch([
      buildJobInsert(db(), job({ eventKey: 'b', createdAt: 100 })),
      buildJobInsert(db(), job({ eventKey: 'a', createdAt: 100 })),
      buildJobInsert(db(), job({ eventKey: 'c', createdAt: 50 })),
    ]);
    await buildCompleteJob(db(), 'c', 500).run();

    const rows = await listOpenJobs(db(), 10);
    expect(rows.map((r) => r.event_key)).toEqual(['a', 'b']);
  });

  it('respects the limit argument', async () => {
    await db().batch([
      buildJobInsert(db(), job({ eventKey: 'a', createdAt: 100 })),
      buildJobInsert(db(), job({ eventKey: 'b', createdAt: 200 })),
    ]);

    const rows = await listOpenJobs(db(), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_key).toBe('a');
  });

  it('orders by updated_at first, so a job that got a page moves behind jobs that did not', async () => {
    await db().batch([
      buildJobInsert(db(), job({ eventKey: 'a', createdAt: 100 })),
      buildJobInsert(db(), job({ eventKey: 'b', createdAt: 200 })),
    ]);
    await buildAdvanceJobCursor(db(), 'a', 'user-1', 999).run();

    const rows = await listOpenJobs(db(), 10);
    expect(rows.map((r) => r.event_key)).toEqual(['b', 'a']);
  });
});

describe('buildAdvanceJobCursor', () => {
  it('sets cursor_user_id and updated_at without touching completed_at', async () => {
    await db().batch([buildJobInsert(db(), job())]);

    await buildAdvanceJobCursor(db(), job().eventKey, 'user-42', 300).run();

    const [row] = await listOpenJobs(db(), 10);
    expect(row.cursor_user_id).toBe('user-42');
    expect(row.updated_at).toBe(300);
    expect(row.completed_at).toBeNull();
  });
});

describe('buildCompleteJob', () => {
  it('sets completed_at and updated_at, removing the row from listOpenJobs', async () => {
    await db().batch([buildJobInsert(db(), job())]);

    await buildCompleteJob(db(), job().eventKey, 400).run();

    expect(await listOpenJobs(db(), 10)).toHaveLength(0);
  });
});

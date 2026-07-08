// On-demand delegator-count refresh -- real D1 (workerd), fake Koios. Verifies the
// staleness gate and that a Koios failure never throws (page render must not break).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { maybeRefreshDelegatorCount } from './delegatorCountRefresh.js';
import { getDrepById } from '../db/dreps.js';

async function seedDrep(drepId: string, syncedAt: number | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at,
                        delegator_count_synced_at)
     VALUES (?, 'registered', 1, 0, 0, ?)`,
  )
    .bind(drepId, syncedAt)
    .run();
}

const koiosOk = { async drepDelegatorCount() { return 12; } };
const koiosThrow = { async drepDelegatorCount(): Promise<number | null> { throw new Error('down'); } };

describe('maybeRefreshDelegatorCount', () => {
  it('refreshes a never-counted DRep', async () => {
    await seedDrep('drep_never', null);
    const did = await maybeRefreshDelegatorCount({
      db: env.DB, koios: koiosOk,
      drep: { drepId: 'drep_never', delegatorCountSyncedAt: null },
      now: 10_000, staleMs: 1000,
    });
    expect(did).toBe(true);
    expect((await getDrepById(env.DB, 'drep_never'))?.delegatorCount).toBe(12);
  });

  it('skips a fresh DRep', async () => {
    await seedDrep('drep_fresh', 9_500);
    const did = await maybeRefreshDelegatorCount({
      db: env.DB, koios: koiosOk,
      drep: { drepId: 'drep_fresh', delegatorCountSyncedAt: 9_500 },
      now: 10_000, staleMs: 1000,
    });
    expect(did).toBe(false);
  });

  it('swallows a Koios failure and returns false', async () => {
    await seedDrep('drep_err', null);
    const did = await maybeRefreshDelegatorCount({
      db: env.DB, koios: koiosThrow,
      drep: { drepId: 'drep_err', delegatorCountSyncedAt: null },
      now: 10_000, staleMs: 1000,
    });
    expect(did).toBe(false);
    expect((await getDrepById(env.DB, 'drep_err'))?.delegatorCount).toBeNull();
  });
});

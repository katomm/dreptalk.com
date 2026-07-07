// Delegator-count sync -- real D1 (workerd) with a fake Koios. Verifies it counts
// the stalest DReps up to the limit, records synced_at, and survives per-DRep
// fetch failures without dropping the successful writes.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncDrepDelegatorCounts } from './delegatorCountSync.js';
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

function fakeKoios(counts: Record<string, number | null>) {
  const asked: string[] = [];
  return {
    asked,
    koios: {
      async drepDelegatorCount(drepId: string): Promise<number | null> {
        asked.push(drepId);
        if (!(drepId in counts)) throw new Error('boom');
        return counts[drepId];
      },
    },
  };
}

describe('syncDrepDelegatorCounts', () => {
  it('counts the stalest DReps up to the limit and stamps synced_at', async () => {
    await seedDrep('drep_a', null); // never counted -> first
    await seedDrep('drep_b', 100); // stale -> second
    await seedDrep('drep_c', 9000); // fresh -> not reached at limit 2
    const fake = fakeKoios({ drep_a: 3, drep_b: 7, drep_c: 99 });

    const res = await syncDrepDelegatorCounts({ koios: fake.koios, db: env.DB, now: 5000, limit: 2 });

    expect(res).toEqual({ scanned: 2, updated: 2, failed: 0 });
    expect(fake.asked).toEqual(['drep_a', 'drep_b']);
    expect((await getDrepById(env.DB, 'drep_a'))?.delegatorCount).toBe(3);
    expect((await getDrepById(env.DB, 'drep_a'))?.delegatorCountSyncedAt).toBe(5000);
    expect((await getDrepById(env.DB, 'drep_c'))?.delegatorCount).toBeNull();
  });

  it('skips a DRep whose fetch fails but still writes the rest', async () => {
    await seedDrep('drep_ok', null);
    await seedDrep('drep_bad', null);
    const fake = fakeKoios({ drep_ok: 4 }); // drep_bad missing -> throws

    const res = await syncDrepDelegatorCounts({ koios: fake.koios, db: env.DB, now: 1, limit: 10 });

    expect(res.updated).toBe(1);
    expect(res.failed).toBe(1);
    expect((await getDrepById(env.DB, 'drep_ok'))?.delegatorCount).toBe(4);
    expect((await getDrepById(env.DB, 'drep_bad'))?.delegatorCount).toBeNull();
  });
});

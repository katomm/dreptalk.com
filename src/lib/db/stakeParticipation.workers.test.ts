// Stake participation D1 aggregation tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises getActiveDrepStake against real miniflare D1.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getActiveDrepStake } from './stakeParticipation.js';

async function seedDrep(drepId: string, votingPower: string, opts: { active?: number; lastSyncedAt?: number } = {}) {
  const { active = 1, lastSyncedAt = 5 } = opts;
  await env.DB.prepare(
    `INSERT INTO dreps (drep_id, hex, status, active, voting_power, last_synced_at, created_at)
     VALUES (?, '', 'registered', ?, ?, ?, 0)`,
  ).bind(drepId, active, votingPower, lastSyncedAt).run();
}

describe('getActiveDrepStake', () => {
  it('total counts only active dreps', async () => {
    await seedDrep('d1', '1000000000000', { lastSyncedAt: 100 });
    await seedDrep('d2', '3000000000000', { lastSyncedAt: 200 });
    await seedDrep('d3', '9000000000000', { active: 0, lastSyncedAt: 999 });
    expect((await getActiveDrepStake(env.DB)).total).toBe(4_000_000_000_000); // d1 + d2, not retired d3
  });

  it('asOf is the max last_synced_at over active dreps only', async () => {
    await seedDrep('d1', '1000000000000', { lastSyncedAt: 100 });
    await seedDrep('d2', '3000000000000', { lastSyncedAt: 200 });
    await seedDrep('d3', '9000000000000', { active: 0, lastSyncedAt: 999 });
    expect((await getActiveDrepStake(env.DB)).asOf).toBe(200); // d2 (200) > d1 (100); retired d3 (999) excluded
  });

  it('sums active representative DReps only, specials excluded', async () => {
    await seedDrep('drep1a', '600');
    await seedDrep('drep1b', '400');
    await seedDrep('drep1gone', '999', { active: 0 });
    await seedDrep('drep_always_abstain', '9000000000000000');
    await seedDrep('drep_always_no_confidence', '150000000000000');
    const r = await getActiveDrepStake(env.DB);
    expect(r.total).toBe(1000);
    expect(r.asOf).toBe(5);
  });
});

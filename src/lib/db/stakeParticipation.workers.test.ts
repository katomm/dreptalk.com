// Stake participation D1 aggregation tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises getActiveDrepStake against real miniflare D1.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getActiveDrepStake } from './stakeParticipation.js';

const db = () => env.DB as D1Database;

async function seed() {
  // Distinct last_synced_at values let us assert asOf is MAX over ACTIVE dreps
  // only: d2 (200) is the freshest active row; the retired d3 (999) is excluded.
  await db().exec("INSERT OR REPLACE INTO dreps (drep_id, status, active, voting_power, last_synced_at, created_at) VALUES ('d1','registered',1,'1000000000000',100,0)");
  await db().exec("INSERT OR REPLACE INTO dreps (drep_id, status, active, voting_power, last_synced_at, created_at) VALUES ('d2','registered',1,'3000000000000',200,0)");
  await db().exec("INSERT OR REPLACE INTO dreps (drep_id, status, active, voting_power, last_synced_at, created_at) VALUES ('d3','retired',0,'9000000000000',999,0)");
}

describe('stakeParticipation', () => {
  beforeEach(async () => {
    await db().exec('DELETE FROM dreps');
  });

  it('total counts only active dreps', async () => {
    await seed();
    expect((await getActiveDrepStake(db())).total).toBe(4_000_000_000_000); // d1 + d2, not retired d3
  });

  it('asOf is the max last_synced_at over active dreps only', async () => {
    await seed();
    expect((await getActiveDrepStake(db())).asOf).toBe(200); // d2 (200) > d1 (100); retired d3 (999) excluded
  });

});

// Stake participation D1 aggregation tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises getTotalDrepVotingPower and getVotedPowerByGaIds against real miniflare D1.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getTotalDrepVotingPower, getVotedPowerByGaIds } from './stakeParticipation.js';

const db = () => env.DB as D1Database;

async function seed() {
  await db().exec("INSERT OR REPLACE INTO dreps (drep_id, status, active, voting_power, last_synced_at, created_at) VALUES ('d1','registered',1,'1000000000000',0,0)");
  await db().exec("INSERT OR REPLACE INTO dreps (drep_id, status, active, voting_power, last_synced_at, created_at) VALUES ('d2','registered',1,'3000000000000',0,0)");
  await db().exec("INSERT OR REPLACE INTO dreps (drep_id, status, active, voting_power, last_synced_at, created_at) VALUES ('d3','retired',0,'9000000000000',0,0)");
  await db().exec("INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at) VALUES ('ga1','DRep','d1','Yes',0)");
  await db().exec("INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at) VALUES ('ga1','DRep','d2','No',0)");
}

describe('stakeParticipation', () => {
  beforeEach(async () => {
    await db().exec('DELETE FROM drep_votes');
    await db().exec('DELETE FROM dreps');
  });

  it('total counts only active dreps', async () => {
    await seed();
    expect(await getTotalDrepVotingPower(db())).toBe(4_000_000_000_000); // d1 + d2, not retired d3
  });

  it('voted power per ga sums voters joined to dreps', async () => {
    await seed();
    const map = await getVotedPowerByGaIds(db(), ['ga1', 'gaX']);
    expect(map.get('ga1')).toBe(4_000_000_000_000);
    expect(map.get('gaX')).toBeUndefined();
  });

  it('empty gaIds returns an empty map without a query', async () => {
    expect((await getVotedPowerByGaIds(db(), [])).size).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listEpochStats, getEpochStatsByEpoch } from './governanceEpochStats.js';
import { getDefaultDelegationCurrent } from './defaultDelegation.js';
import { getDrepActivityBreakdown } from './drepActivityBreakdown.js';

async function seedStats(epoch: number, over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    epoch,
    total_drep_power: '1000',
    powered_drep_count: 3,
    recently_voting_drep_count: 2,
    abstain_power: '500',
    anc_power: '50',
    delegator_total: null,
    abstain_delegators: null,
    anc_delegators: null,
    gini: 0.4,
    top10_share_pct: 80,
    min_coalition_50: 1,
    min_coalition_67: 2,
    votes_cast: 5,
    vote_data_complete: 1,
    treasury_lovelace: '77',
    computed_at: 0,
    ...over,
  };
  const cols = Object.keys(base);
  await env.DB.prepare(
    `INSERT INTO governance_epoch_stats (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).bind(...cols.map((c) => base[c])).run();
}

async function seedDrep(drepId: string, over: Record<string, unknown> = {}) {
  // dreps has several NOT NULL columns with no default (see migrations/0005_dreps.sql):
  // status, active, last_synced_at, created_at. has_script and anchor_status are
  // also NOT NULL but carry DEFAULTs, so they are left out here.
  const base: Record<string, unknown> = {
    drep_id: drepId,
    hex: drepId,
    status: 'registered',
    active: 1,
    voting_power: '100',
    delegator_count: null,
    last_synced_at: 1000,
    created_at: 0,
    ...over,
  };
  const cols = Object.keys(base);
  await env.DB.prepare(
    `INSERT INTO dreps (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).bind(...cols.map((c) => base[c])).run();
}

describe('listEpochStats', () => {
  it('returns rows epoch ascending, mapped to camelCase', async () => {
    await seedStats(540, { vote_data_complete: 0 });
    await seedStats(538, { delegator_total: 90000 });
    const rows = await listEpochStats(env.DB);
    expect(rows.map((r) => r.epoch)).toEqual([538, 540]);
    expect(rows[0].delegatorTotal).toBe(90000);
    expect(rows[0].voteDataComplete).toBe(true);
    expect(rows[1].voteDataComplete).toBe(false);
    expect(rows[1].totalDrepPower).toBe('1000');
  });

  it('honors fromEpoch', async () => {
    await seedStats(538);
    await seedStats(539);
    const rows = await listEpochStats(env.DB, { fromEpoch: 539 });
    expect(rows.map((r) => r.epoch)).toEqual([539]);
  });
});

describe('getEpochStatsByEpoch', () => {
  it('returns the row mapped to camelCase on a hit', async () => {
    await seedStats(540, { total_drep_power: '12345', top10_share_pct: 55.5 });
    const row = await getEpochStatsByEpoch(env.DB, 540);
    expect(row?.epoch).toBe(540);
    expect(row?.totalDrepPower).toBe('12345');
    expect(row?.top10SharePct).toBe(55.5);
  });

  it('returns null on a miss', async () => {
    await seedStats(540);
    const row = await getEpochStatsByEpoch(env.DB, 999);
    expect(row).toBeNull();
  });
});

describe('getDefaultDelegationCurrent', () => {
  it('reads the two special rows and nothing else', async () => {
    await seedDrep('drep_always_abstain', { voting_power: '9000', delegator_count: 193000 });
    await seedDrep('drep1regular', { voting_power: '600' });
    const r = await getDefaultDelegationCurrent(env.DB);
    expect(r.abstain?.votingPower).toBe('9000');
    expect(r.abstain?.delegatorCount).toBe(193000);
    expect(r.noConfidence).toBeNull();
  });
});

describe('getDrepActivityBreakdown', () => {
  it('counts layers with specials excluded and sums inactive stake as BigInt', async () => {
    await seedDrep('drep1a', { voting_power: '600' });
    await seedDrep('drep1b', { voting_power: '0' });
    await seedDrep('drep1gone', { active: 0, voting_power: '9007199254740993' }); // above 2^53
    await seedDrep('drep1gone2', { active: 0, voting_power: '7' });
    await seedDrep('drep_always_abstain', { voting_power: '9000' });
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, topic_id, created_at, last_synced_at)
       VALUES ('ga1', 'InfoAction', 't', 'active', NULL, 0, 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_id, voter_role, vote, block_time, synced_at)
       VALUES ('ga1', 'drep1a', 'DRep', 'Yes', 10, 0), ('ga1', 'drep_always_abstain', 'DRep', 'Abstain', 20, 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO drep_vote_history (ga_id, voter_id, vote, block_time, superseded_at, voter_role)
       VALUES ('ga1', 'drep1gone2', 'No', 5, 10, 'DRep')`,
    ).run();

    const b = await getDrepActivityBreakdown(env.DB);
    expect(b.registered).toBe(4);
    expect(b.active).toBe(2);
    expect(b.powered).toBe(1);
    expect(b.everVoted).toBe(2); // drep1a live vote + drep1gone2 superseded, special excluded
    expect(b.inactiveCount).toBe(2);
    expect(b.inactiveStake).toBe('9007199254741000'); // exact BigInt sum, not a float
  });
});

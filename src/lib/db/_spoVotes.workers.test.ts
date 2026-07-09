import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { countPoolVotes, getPoolParticipation, getPoolRationaleStats, getPoolVoteBreakdown, getPoolVotingHistory } from './drepVotes.js';

const NOW = 1_700_000_000;

async function seedActionWithSpoVote(gaId: string, poolId: string, vote: string, meta: string | null, decidedEpoch: number | null) {
  await env.DB
    .prepare(
      `INSERT INTO governance_actions (id, type, anchor_status, status, created_at, last_synced_at, decided_epoch, title)
       VALUES (?, 'HardForkInitiation', 'no-anchor', 'ratified', ?, ?, ?, ?)`,
    )
    .bind(gaId, NOW, NOW, decidedEpoch, `Action ${gaId}`)
    .run();
  await env.DB
    .prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, block_time, synced_at)
       VALUES (?, 'SPO', ?, NULL, ?, ?, ?, ?)`,
    )
    .bind(gaId, poolId, vote, meta, NOW, NOW)
    .run();
}

describe('SPO vote stats', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM drep_votes; DELETE FROM governance_actions;');
  });

  it('counts, breaks down, and reports rationale rate for a pool', async () => {
    await seedActionWithSpoVote('ga-1', 'pool1x', 'Yes', 'https://r/1', 10);
    await seedActionWithSpoVote('ga-2', 'pool1x', 'No', null, 11);

    expect(await countPoolVotes(env.DB, 'pool1x')).toBe(2);
    expect(await getPoolVoteBreakdown(env.DB, 'pool1x')).toEqual({ yes: 1, no: 1, abstain: 0, total: 2 });
    expect(await getPoolRationaleStats(env.DB, 'pool1x')).toEqual({ total: 2, without: 1, withRationale: 1 });
    expect((await getPoolVotingHistory(env.DB, 'pool1x')).map((r) => r.ga_id)).toEqual(['ga-2', 'ga-1']);
  });

  it('participation counts decided actions that any SPO voted on', async () => {
    await seedActionWithSpoVote('ga-1', 'pool1x', 'Yes', null, 10); // pool1x voted
    await seedActionWithSpoVote('ga-2', 'pool1y', 'Yes', null, 11); // another SPO voted, pool1x did not
    const p = await getPoolParticipation(env.DB, 'pool1x');
    expect(p).toEqual({ eligible: 2, voted: 1 });
  });
});

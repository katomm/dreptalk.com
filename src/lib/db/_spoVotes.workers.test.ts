import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { countActionSpoVoters, countPoolVotes, getActionSpoVoters, getPoolParticipation, getPoolRationaleStats, getPoolVoteBreakdown, getPoolVotingHistory } from './drepVotes.js';

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

  it('orders a pool history by vote time, surfacing a recent vote on an open action', async () => {
    // Decided action, voted at NOW.
    await seedActionWithSpoVote('ga-old', 'poolRev', 'Yes', null, 10);
    // Open action (decided_epoch NULL) with a more recent vote.
    await env.DB
      .prepare(
        `INSERT INTO governance_actions (id, type, anchor_status, status, created_at, last_synced_at, decided_epoch, title)
         VALUES ('ga-open', 'InfoAction', 'no-anchor', 'voting', ?, ?, NULL, 'Open Action')`,
      )
      .bind(NOW, NOW)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, block_time, synced_at)
         VALUES ('ga-open', 'SPO', 'poolRev', NULL, 'No', NULL, ?, ?)`,
      )
      .bind(NOW + 1000, NOW)
      .run();

    expect((await getPoolVotingHistory(env.DB, 'poolRev')).map((r) => r.ga_id)).toEqual(['ga-open', 'ga-old']);
  });

  it('participation counts decided actions that any SPO voted on', async () => {
    await seedActionWithSpoVote('ga-1', 'pool1x', 'Yes', null, 10); // pool1x voted
    await seedActionWithSpoVote('ga-2', 'pool1y', 'Yes', null, 11); // another SPO voted, pool1x did not
    const p = await getPoolParticipation(env.DB, 'pool1x');
    expect(p).toEqual({ eligible: 2, voted: 1 });
  });

  it('hides a locally failed SPO vote from every pool read (same rule as DRep reads)', async () => {
    await seedActionWithSpoVote('ga-live', 'poolF', 'Yes', null, 10);
    // A failed optimistic vote: submitted from the app but never confirmed on
    // chain, marked 'failed' by markStalePendingVotesFailed. It must not count
    // in any public pool read, mirroring the DRep-side predicate.
    await env.DB
      .prepare(
        `INSERT INTO governance_actions (id, type, anchor_status, status, created_at, last_synced_at, decided_epoch, title)
         VALUES ('ga-failed', 'InfoAction', 'no-anchor', 'voting', ?, ?, 11, 'Failed Vote Action')`,
      )
      .bind(NOW, NOW)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, block_time, synced_at, local_status)
         VALUES ('ga-failed', 'SPO', 'poolF', NULL, 'No', NULL, ?, ?, 'failed')`,
      )
      .bind(NOW + 500, NOW)
      .run();

    expect(await countPoolVotes(env.DB, 'poolF')).toBe(1);
    expect(await getPoolVoteBreakdown(env.DB, 'poolF')).toEqual({ yes: 1, no: 0, abstain: 0, total: 1 });
    expect(await getPoolRationaleStats(env.DB, 'poolF')).toEqual({ total: 1, without: 1, withRationale: 0 });
    expect((await getPoolVotingHistory(env.DB, 'poolF')).map((r) => r.ga_id)).toEqual(['ga-live']);
    // A failed vote is no evidence the action was SPO-votable: eligible stays 1.
    expect(await getPoolParticipation(env.DB, 'poolF')).toEqual({ eligible: 1, voted: 1 });
    // The per-action voter list and count exclude it too.
    expect(await getActionSpoVoters(env.DB, 'ga-failed')).toEqual([]);
    expect(await countActionSpoVoters(env.DB, 'ga-failed')).toBe(0);
  });
});

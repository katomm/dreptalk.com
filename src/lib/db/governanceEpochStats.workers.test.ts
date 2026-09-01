import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertEpochStats,
  insertEpochStatsIfMissing,
  getStoredStatsEpochs,
  countDrepVotesInEpoch,
  countRecentlyVotingDreps,
  countUnsweptActions,
  listIncompleteVoteDataEpochs,
  updateVoteDerivedStats,
} from './governanceEpochStats.js';
import { resolveNetwork, epochStartUnix } from '../config/network.js';
import type { EpochStatsRow } from '../analytics/epochStats.js';

const cfg = resolveNetwork('mainnet');

function row(epoch: number, over: Partial<EpochStatsRow> = {}): EpochStatsRow {
  return {
    epoch,
    totalDrepPower: '1000',
    poweredDrepCount: 3,
    recentlyVotingDrepCount: 2,
    abstainPower: '500',
    ancPower: '50',
    delegatorTotal: null,
    abstainDelegators: null,
    ancDelegators: null,
    gini: 0.4,
    top10SharePct: 80,
    minCoalition50: 1,
    minCoalition67: 2,
    votesCast: 5,
    voteDataComplete: false,
    treasuryLovelace: '77',
    ...over,
  };
}

describe('epoch stats persistence', () => {
  it('upsert updates in place, insertIfMissing never overwrites', async () => {
    await upsertEpochStats(env.DB, row(540, { votesCast: 5 }));
    await upsertEpochStats(env.DB, row(540, { votesCast: 9 }));
    const kept = await insertEpochStatsIfMissing(env.DB, row(540, { votesCast: 1 }));
    expect(kept).toBe(false);
    const stored = await env.DB.prepare(
      'SELECT votes_cast FROM governance_epoch_stats WHERE epoch = 540',
    ).first<{ votes_cast: number }>();
    expect(stored?.votes_cast).toBe(9);
    expect(await getStoredStatsEpochs(env.DB)).toEqual(new Set([540]));
  });

  it('keeps the earlier treasury value when a later upsert writes null', async () => {
    await upsertEpochStats(env.DB, row(550, { treasuryLovelace: '77' }));
    await upsertEpochStats(env.DB, row(550, { treasuryLovelace: null }));
    const stored = await env.DB.prepare(
      'SELECT treasury_lovelace FROM governance_epoch_stats WHERE epoch = 550',
    ).first<{ treasury_lovelace: string }>();
    expect(stored?.treasury_lovelace).toBe('77');
  });

  it('repairs both vote-derived columns together', async () => {
    await upsertEpochStats(env.DB, row(540, { voteDataComplete: false }));
    await upsertEpochStats(env.DB, row(541, { voteDataComplete: true }));
    expect(await listIncompleteVoteDataEpochs(env.DB)).toEqual([540]);
    await updateVoteDerivedStats(env.DB, 540, 42, 7, true);
    expect(await listIncompleteVoteDataEpochs(env.DB)).toEqual([]);
    const stored = await env.DB.prepare(
      'SELECT votes_cast, recently_voting_drep_count FROM governance_epoch_stats WHERE epoch = 540',
    ).first<{ votes_cast: number; recently_voting_drep_count: number }>();
    expect(stored?.votes_cast).toBe(42);
    expect(stored?.recently_voting_drep_count).toBe(7);
  });
});

describe('vote counting', () => {
  it('counts current and superseded DRep votes inside the epoch bounds, specials excluded by SQL', async () => {
    const t0 = epochStartUnix(540, cfg);
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, topic_id, created_at, last_synced_at)
       VALUES ('ga1', 'InfoAction', 't', 'active', NULL, 0, 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_id, voter_role, vote, block_time, synced_at)
       VALUES ('ga1', 'drepA', 'DRep', 'Yes', ?, 0), ('ga1', 'drepB', 'DRep', 'No', ?, 0),
              ('ga1', 'poolX', 'SPO', 'Yes', ?, 0), ('ga1', 'drep_always_abstain', 'DRep', 'Abstain', ?, 0)`,
    ).bind(t0 + 10, t0 + 20, t0 + 30, t0 + 40).run();
    await env.DB.prepare(
      `INSERT INTO drep_vote_history (ga_id, voter_id, vote, block_time, superseded_at, voter_role)
       VALUES ('ga1', 'drepA', 'No', ?, ?, 'DRep')`,
    ).bind(t0 + 5, t0 + 10).run();

    // The special-id row above cannot exist on chain, it is seeded exactly to
    // prove the SQL guarantees includesSpecials: false instead of assuming it.
    expect(await countDrepVotesInEpoch(env.DB, 540, cfg)).toBe(3);
    expect(await countDrepVotesInEpoch(env.DB, 541, cfg)).toBe(0);
    expect(await countRecentlyVotingDreps(env.DB, 540, cfg, 12)).toBe(2);
    expect(await countRecentlyVotingDreps(env.DB, 560, cfg, 12)).toBe(0);
  });

  it('counts a DRep whose only vote in the window is superseded', async () => {
    const t0 = epochStartUnix(540, cfg);
    await env.DB.prepare(
      `INSERT INTO drep_vote_history (ga_id, voter_id, vote, block_time, superseded_at, voter_role)
       VALUES ('ga2', 'drepOnlySuperseded', 'Yes', ?, ?, 'DRep')`,
    ).bind(t0 + 5, t0 + 10).run();
    expect(await countRecentlyVotingDreps(env.DB, 540, cfg, 12)).toBe(1);
  });

  it('reports unswept actions', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, topic_id, created_at, last_synced_at, vote_history_swept_at)
       VALUES ('gaS', 'InfoAction', 't', 'active', NULL, 0, 0, NULL), ('gaT', 'InfoAction', 't', 'active', NULL, 0, 0, 123)`,
    ).run();
    expect(await countUnsweptActions(env.DB)).toBe(1);
  });
});

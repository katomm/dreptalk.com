import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  EPOCH_STATS_METRICS,
  seriesStartEpoch,
  RECENT_VOTING_WINDOW_EPOCHS,
} from './epochStatsContract.js';

async function seedRow(epoch: number, over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    epoch,
    total_drep_power: '1000',
    powered_drep_count: 10,
    recently_voting_drep_count: 5,
    abstain_power: '500',
    anc_power: '50',
    delegator_total: null,
    abstain_delegators: null,
    anc_delegators: null,
    gini: 0.5,
    top10_share_pct: 40,
    min_coalition_50: 3,
    min_coalition_67: 5,
    votes_cast: 12,
    vote_data_complete: 1,
    treasury_lovelace: '99',
    computed_at: 0,
    ...over,
  };
  const cols = Object.keys(base);
  await env.DB.prepare(
    `INSERT INTO governance_epoch_stats (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).bind(...cols.map((c) => base[c])).run();
}

describe('metric contract', () => {
  it('covers every table column exactly once', async () => {
    const info = (
      await env.DB.prepare(`PRAGMA table_info('governance_epoch_stats')`).all<{ name: string }>()
    ).results ?? [];
    const tableCols = info.map((r) => r.name).filter((n) => !['epoch', 'computed_at', 'vote_data_complete'].includes(n));
    const contractCols = Object.values(EPOCH_STATS_METRICS).map((m) => m.column).sort();
    expect(contractCols).toEqual([...tableCols].sort());
  });

  it('has a definition, reliability and start rule on every metric', () => {
    for (const m of Object.values(EPOCH_STATS_METRICS)) {
      expect(m.definition.length).toBeGreaterThan(20);
      expect(['exact', 'forward-only', 'flagged']).toContain(m.reliability);
      expect(['oldest-row', 'first-non-null', 'first-complete']).toContain(m.start);
    }
  });

  it('gates both vote-derived metrics with the shared flag', () => {
    expect(EPOCH_STATS_METRICS.votesCast.reliability).toBe('flagged');
    expect(EPOCH_STATS_METRICS.votesCast.start).toBe('first-complete');
    expect(EPOCH_STATS_METRICS.recentlyVotingDrepCount.reliability).toBe('flagged');
    expect(EPOCH_STATS_METRICS.recentlyVotingDrepCount.start).toBe('first-complete');
  });

  it('starts nullable exact metrics at first-non-null', () => {
    expect(EPOCH_STATS_METRICS.abstainPower.start).toBe('first-non-null');
    expect(EPOCH_STATS_METRICS.ancPower.start).toBe('first-non-null');
    expect(EPOCH_STATS_METRICS.treasuryLovelace.start).toBe('first-non-null');
  });

  it('exposes the recently-voting window as 12 epochs', () => {
    expect(RECENT_VOTING_WINDOW_EPOCHS).toBe(12);
  });
});

describe('seriesStartEpoch', () => {
  it('returns null with no rows', async () => {
    expect(await seriesStartEpoch(env.DB, 'totalDrepPower')).toBeNull();
  });

  it('starts oldest-row metrics at the oldest stored epoch', async () => {
    await seedRow(510);
    await seedRow(511);
    expect(await seriesStartEpoch(env.DB, 'totalDrepPower')).toBe(510);
    expect(await seriesStartEpoch(env.DB, 'gini')).toBe(510);
  });

  it('starts first-non-null metrics at their first non-NULL epoch, exact ones included', async () => {
    await seedRow(510, { delegator_total: null, treasury_lovelace: null });
    await seedRow(511, { delegator_total: 90000, treasury_lovelace: null });
    await seedRow(512, { delegator_total: 91000, treasury_lovelace: '77' });
    expect(await seriesStartEpoch(env.DB, 'delegatorTotal')).toBe(511);
    expect(await seriesStartEpoch(env.DB, 'treasuryLovelace')).toBe(512);
  });

  it('starts first-complete metrics at the first complete epoch', async () => {
    await seedRow(510, { vote_data_complete: 0 });
    await seedRow(511, { vote_data_complete: 1 });
    expect(await seriesStartEpoch(env.DB, 'votesCast')).toBe(511);
    expect(await seriesStartEpoch(env.DB, 'recentlyVotingDrepCount')).toBe(511);
  });
});

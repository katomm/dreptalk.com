// The review state builder: where the review stands from the sync's own
// tables, independent of any published edition (the content collection is
// empty in this test environment, so lastCoveredEpoch is always passed in).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { buildReviewState } from '@/lib/review/state';
import { resolveNetwork, epochStartUnix } from '@/lib/config/network';

const cfg = resolveNetwork('mainnet');

async function seedStats(epoch: number, complete: 0 | 1) {
  await env.DB.prepare(
    `INSERT INTO governance_epoch_stats (epoch, total_drep_power, powered_drep_count, recently_voting_drep_count, gini, top10_share_pct, min_coalition_50, min_coalition_67, votes_cast, vote_data_complete, computed_at)
     VALUES (?, '5000000000000000', 880, 300, 0.94, 50.1, 10, 20, 100, ?, 0)`,
  ).bind(epoch, complete).run();
}

describe('buildReviewState', () => {
  it('reports the candidate window, per-epoch readiness and watermarks', async () => {
    for (const e of [650, 651]) await seedStats(e, 1);
    await seedStats(652, 0);
    const end653 = epochStartUnix(653, cfg);
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, submitted_epoch, expiry_epoch, topic_id, created_at, last_synced_at, votes_synced_at)
       VALUES ('a#0', 'NewCommittee', 'Update CC', 'active', 646, 653, NULL, 0, ?, ?)`,
    ).bind((end653 + 3600) * 1000, (end653 + 3600) * 1000).run();
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES ('a#0', 'DRep', 'drep1', 'Yes', ?, ?)`,
    ).bind((end653 + 3600) * 1000, end653 - 100).run();

    const nowMs = (end653 + 8 * 3600) * 1000;
    const state = await buildReviewState(env.DB, cfg, { lastCoveredEpoch: 649, nowMs });
    expect(state.currentEpoch).toBe(653);
    expect(state.candidateWindow).toEqual({ from: 650, to: 652 });
    expect(state.closedEpochs).toEqual([650, 651, 652]);
    expect(state.readiness.ready).toBe(false);
    expect(state.readiness.epochs['652'].stats).toBe('pending');
    expect(state.readiness.epochs['650'].ready).toBe(true);
    expect(state.signals?.rareDecided.map((s) => s.id)).toEqual(['a#0']);
  });

  it('keeps an epoch pending while a relevant action is stale even when another action is fresh', async () => {
    for (const e of [650, 651, 652]) await seedStats(e, 1);
    const end651 = epochStartUnix(652, cfg);
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, submitted_epoch, expiry_epoch, topic_id, created_at, last_synced_at)
       VALUES ('stale#0', 'InfoAction', 'Stale', 'active', 648, 655, NULL, 0, ?), ('fresh#0', 'InfoAction', 'Fresh', 'active', 649, 656, NULL, 0, ?)`,
    ).bind((end651 - 3600) * 1000, (end651 + 7200) * 1000).run();
    await env.DB.prepare(`UPDATE governance_actions SET votes_synced_at = last_synced_at`).run();
    const nowMs = (epochStartUnix(653, cfg) + 8 * 3600) * 1000;
    const state = await buildReviewState(env.DB, cfg, { lastCoveredEpoch: 649, nowMs });
    expect(state.readiness.epochs['651'].actions).toBe('pending');
    expect(state.readiness.epochs['651'].staleOpenActions).toBe(1);
  });

  it('keeps an epoch pending while a boundary action has a fresh tally but no final vote fetch', async () => {
    for (const e of [650, 651, 652]) await seedStats(e, 1);
    const end652 = epochStartUnix(653, cfg);
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, submitted_epoch, expiry_epoch, topic_id, created_at, last_synced_at, votes_synced_at)
       VALUES ('frozen#0', 'NewCommittee', 'Frozen', 'ratified', 646, 653, NULL, 0, ?, NULL)`,
    ).bind((end652 + 3600) * 1000).run();
    const nowMs = (end652 + 8 * 3600) * 1000;
    const state = await buildReviewState(env.DB, cfg, { lastCoveredEpoch: 649, nowMs });
    expect(state.readiness.epochs['652'].votes).toBe('pending');
    expect(state.readiness.ready).toBe(false);
    await env.DB.prepare(`UPDATE governance_actions SET votes_synced_at = ? WHERE id = 'frozen#0'`).bind((end652 + 7200) * 1000).run();
    const after = await buildReviewState(env.DB, cfg, { lastCoveredEpoch: 649, nowMs });
    expect(after.readiness.epochs['652'].votes).toBe('available');
  });

  it('caps the candidate at the last closed epoch', async () => {
    const nowMs = epochStartUnix(651, cfg) * 1000 + 1000;
    const state = await buildReviewState(env.DB, cfg, { lastCoveredEpoch: 649, nowMs });
    expect(state.candidateWindow).toEqual({ from: 650, to: 650 });
    expect(state.closedEpochs).toEqual([650]);
  });
});

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncCurrentEpochStats, backfillEpochStats } from './epochStatsSync.js';
import { resolveNetwork, epochStartUnix } from '../config/network.js';

const cfg = resolveNetwork('mainnet');

async function seedHistory(epoch: number, rows: [string, string, number | null][]) {
  for (const [drepId, amount, count] of rows) {
    await env.DB.prepare(
      'INSERT INTO drep_voting_power_history (drep_id, epoch, amount, delegator_count) VALUES (?, ?, ?, ?)',
    ).bind(drepId, epoch, amount, count).run();
  }
}

async function statsRow(epoch: number) {
  return env.DB.prepare('SELECT * FROM governance_epoch_stats WHERE epoch = ?').bind(epoch)
    .first<Record<string, unknown>>();
}

function makeKoios(over: Partial<Record<'emptyEpochs' | 'nullTotalsEpochs', number[]>> = {}) {
  const emptyEpochs = new Set(over.emptyEpochs ?? []);
  const nullTotalsEpochs = new Set(over.nullTotalsEpochs ?? []);
  return {
    totals: async (epochNo?: number) =>
      epochNo != null && nullTotalsEpochs.has(epochNo)
        ? null
        : { epochNo: epochNo ?? 999, treasuryLovelace: '4242', reservesLovelace: '1' },
    firstDrepPowerEpoch: async () => 538,
    drepVotingPowerHistory: async (epochNo: number, _limit?: number, offset = 0) =>
      offset > 0 || emptyEpochs.has(epochNo) ? [] : [
        { drep_id: 'drep1backfilled', epoch_no: epochNo, amount: '700' },
        { drep_id: 'drep_always_abstain', epoch_no: epochNo, amount: '9000' },
      ],
  };
}

describe('syncCurrentEpochStats', () => {
  it('writes the current epoch from stored history and converges on rerun', async () => {
    await seedHistory(540, [
      ['drep1a', '600', 100],
      ['drep1b', '400', null],
      ['drep_always_abstain', '9000', 200],
    ]);
    const r1 = await syncCurrentEpochStats({ db: env.DB, koios: makeKoios(), cfg, epoch: 540 });
    expect(r1.written).toBe(true);
    let row = await statsRow(540);
    expect(row?.total_drep_power).toBe('1000');
    expect(row?.abstain_power).toBe('9000');
    expect(row?.abstain_delegators).toBe(200);
    // One row is unstamped, so no partial total is stored.
    expect(row?.delegator_total).toBeNull();
    expect(row?.treasury_lovelace).toBe('4242');
    // The live pass always writes an open epoch as vote-incomplete, even
    // though nothing is currently unswept, the epoch itself is still open.
    expect(row?.vote_data_complete).toBe(0);

    // A later run in the same epoch sees the completed stamps and heals.
    await env.DB.prepare(
      'UPDATE drep_voting_power_history SET delegator_count = 50 WHERE drep_id = ? AND epoch = 540',
    ).bind('drep1b').run();
    await syncCurrentEpochStats({ db: env.DB, koios: makeKoios(), cfg, epoch: 540 });
    row = await statsRow(540);
    expect(row?.delegator_total).toBe(150);
    expect(row?.vote_data_complete).toBe(0);
  });

  it('skips without history rows for the epoch', async () => {
    const r = await syncCurrentEpochStats({ db: env.DB, koios: makeKoios(), cfg, epoch: 999 });
    expect(r.written).toBe(false);
  });
});

describe('backfillEpochStats', () => {
  it('drains oldest-first under the budget, transient fetches, delegators NULL', async () => {
    const r1 = await backfillEpochStats({
      db: env.DB, koios: makeKoios(), cfg, currentEpoch: 541, budget: 2,
    });
    expect(r1.inserted).toBe(2);
    expect(r1.remaining).toBe(1); // floor 538, current 541, past epochs 538..540, 2 done
    const row = await statsRow(538);
    expect(row?.total_drep_power).toBe('700');
    expect(row?.abstain_power).toBe('9000');
    expect(row?.delegator_total).toBeNull();
    expect(row?.abstain_delegators).toBeNull();
    // Nothing was written into the history table itself.
    const hist = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM drep_voting_power_history WHERE epoch = 538',
    ).first<{ n: number }>();
    expect(hist?.n).toBe(0);

    const r2 = await backfillEpochStats({
      db: env.DB, koios: makeKoios(), cfg, currentEpoch: 541, budget: 5,
    });
    expect(r2.inserted).toBe(1);
    expect(r2.remaining).toBe(0);
  });

  it('keeps an empty-fetch epoch in remaining instead of counting it done', async () => {
    const r = await backfillEpochStats({
      db: env.DB, koios: makeKoios({ emptyEpochs: [538] }), cfg, currentEpoch: 541, budget: 3,
    });
    expect(r.inserted).toBe(2); // 539 and 540
    expect(r.remaining).toBe(1); // 538 stays missing and is retried next run
  });

  it('skips an epoch whose totals fetch resolves null, no NULL-treasury row is written', async () => {
    const r = await backfillEpochStats({
      db: env.DB, koios: makeKoios({ nullTotalsEpochs: [539] }), cfg, currentEpoch: 541, budget: 3,
    });
    expect(r.inserted).toBe(2); // 538 and 540, 539 skipped
    expect(r.remaining).toBe(1); // 539 stays missing and is retried next run
    const row = await statsRow(539);
    expect(row).toBeNull();
  });

  it('repairs both vote-derived columns once the sweep drained', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, topic_id, created_at, last_synced_at, vote_history_swept_at)
       VALUES ('gaU', 'InfoAction', 't', 'active', NULL, 0, 0, NULL)`,
    ).run();
    await backfillEpochStats({ db: env.DB, koios: makeKoios(), cfg, currentEpoch: 539, budget: 1 });
    let row = await statsRow(538);
    expect(row?.vote_data_complete).toBe(0);

    await env.DB.prepare('UPDATE governance_actions SET vote_history_swept_at = 5 WHERE id = ?').bind('gaU').run();
    const r = await backfillEpochStats({ db: env.DB, koios: makeKoios(), cfg, currentEpoch: 539, budget: 1 });
    expect(r.repaired).toBe(1);
    row = await statsRow(538);
    expect(row?.vote_data_complete).toBe(1);
  });
});

describe('finalization after an epoch roll', () => {
  it('live-pass epoch freezes at flag 0, the next backfill run repairs it once closed', async () => {
    await seedHistory(540, [
      ['drep1a', '600', 100],
      ['drep1b', '400', 50],
    ]);
    const t0 = epochStartUnix(540, cfg);
    // Already swept: the sweep state is not what this test is about, an open
    // epoch must stay incomplete even when nothing is unswept.
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, topic_id, created_at, last_synced_at, vote_history_swept_at)
       VALUES ('gaF', 'InfoAction', 't', 'active', NULL, 0, 0, 5)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_id, voter_role, vote, block_time, synced_at)
       VALUES ('gaF', 'drep1a', 'DRep', 'Yes', ?, 0)`,
    ).bind(t0 + 10).run();

    const live = await syncCurrentEpochStats({ db: env.DB, koios: makeKoios(), cfg, epoch: 540 });
    expect(live.written).toBe(true);
    let row = await statsRow(540);
    // Written while the epoch is still open: incomplete no matter what the
    // sweep looks like, this is the bug the finalization guards against.
    expect(row?.vote_data_complete).toBe(0);
    expect(row?.votes_cast).toBe(1);

    // Roll to the next epoch: 540 is closed, the live pass never writes it
    // again, so the backfill's repair pass must finalize it instead.
    const r = await backfillEpochStats({ db: env.DB, koios: makeKoios(), cfg, currentEpoch: 541, budget: 0 });
    expect(r.repaired).toBe(1);
    row = await statsRow(540);
    expect(row?.vote_data_complete).toBe(1);
    // Recomputed from the same local vote data, not just a flag flip.
    expect(row?.votes_cast).toBe(1);
    expect(row?.recently_voting_drep_count).toBe(1);
  });
});

// Voting-power-history sync -- run in real workerd. Exercises the self-healing
// fetch (only missing epochs), rolling-window prune, and denormalization against
// the real D1 binding with a fake Koios client.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncDrepVotingPowerHistory } from './votingPowerHistorySync.js';
import {
  getStoredEpochs,
  getDrepVotingPowerSeries,
  insertVotingPowerHistory,
} from '../db/drepVotingPowerHistory.js';
import type { DrepVotingPowerHistoryRow } from '../koios/client.js';

async function seedDrep(drepId: string, votingPower: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dreps (drep_id, status, voting_power, last_synced_at, created_at)
     VALUES (?, 'registered', ?, 0, 0)`,
  )
    .bind(drepId, votingPower)
    .run();
}

// Fake Koios: serves a fixed amount per (epoch) for two DReps and records which
// epochs were requested. Pagination short-circuits after the first page.
function fakeKoios(amountByEpoch: Record<number, Record<string, string>>) {
  const requested: number[] = [];
  return {
    requested,
    koios: {
      async drepVotingPowerHistory(epochNo: number, _limit = 1000, offset = 0): Promise<DrepVotingPowerHistoryRow[]> {
        if (offset === 0) requested.push(epochNo);
        if (offset > 0) return [];
        const byDrep = amountByEpoch[epochNo] ?? {};
        return Object.entries(byDrep).map(([drep_id, amount]) => ({ drep_id, epoch_no: epochNo, amount }));
      },
    },
  };
}

describe('syncDrepVotingPowerHistory', () => {
  it('fetches the whole window on a cold run and denormalizes the latest two snapshots', async () => {
    await seedDrep('drepA', '150');
    const { koios, requested } = fakeKoios({
      539: { drepA: '100' },
      540: { drepA: '150' },
    });

    const res = await syncDrepVotingPowerHistory({ koios, db: env.DB, currentEpoch: 540, windowSize: 4 });

    expect(res.window).toEqual([537, 538, 539, 540]);
    expect(requested.sort((a, b) => a - b)).toEqual([537, 538, 539, 540]);
    expect(res.inserted).toBe(2);

    expect(await getDrepVotingPowerSeries(env.DB, 'drepA')).toEqual([
      { epoch: 539, amount: '100', delegatorCount: null },
      { epoch: 540, amount: '150', delegatorCount: null },
    ]);
    const row = await env.DB.prepare(
      'SELECT voting_power_snapshot AS s, voting_power_prev AS p, voting_power_snapshot_epoch AS e FROM dreps WHERE drep_id = ?',
    )
      .bind('drepA')
      .first<{ s: string | null; p: string | null; e: number | null }>();
    expect(row).toMatchObject({ s: '150', p: '100', e: 540 });
  });

  it('only fetches epochs not already stored', async () => {
    await insertVotingPowerHistory(env.DB, [
      { drepId: 'drepA', epoch: 538, amount: '90' },
      { drepId: 'drepA', epoch: 539, amount: '100' },
    ]);
    const { koios, requested } = fakeKoios({ 540: { drepA: '150' } });

    const res = await syncDrepVotingPowerHistory({ koios, db: env.DB, currentEpoch: 540, windowSize: 4 });

    // 537 and 540 are missing; 538/539 already stored and are not re-requested.
    expect(requested.sort((a, b) => a - b)).toEqual([537, 540]);
    expect(res.fetchedEpochs.sort((a, b) => a - b)).toEqual([537, 540]);
  });

  it('skips the denormalize when no new epoch was fetched (whole window already stored)', async () => {
    await seedDrep('drepA', '150');
    // The full window is already present, so the sync fetches nothing.
    await insertVotingPowerHistory(env.DB, [
      { drepId: 'drepA', epoch: 537, amount: '1' },
      { drepId: 'drepA', epoch: 538, amount: '2' },
      { drepId: 'drepA', epoch: 539, amount: '100' },
      { drepId: 'drepA', epoch: 540, amount: '150' },
    ]);
    // Sentinel snapshot columns: if denormalize ran it would overwrite these.
    await env.DB.prepare(
      "UPDATE dreps SET voting_power_snapshot = 'SENTINEL', voting_power_prev = 'SENTINEL', voting_power_snapshot_epoch = -1 WHERE drep_id = 'drepA'",
    ).run();
    const { koios } = fakeKoios({});

    const res = await syncDrepVotingPowerHistory({ koios, db: env.DB, currentEpoch: 540, windowSize: 4 });

    expect(res.fetchedEpochs).toEqual([]);
    const row = await env.DB.prepare(
      'SELECT voting_power_snapshot AS s, voting_power_prev AS p, voting_power_snapshot_epoch AS e FROM dreps WHERE drep_id = ?',
    )
      .bind('drepA')
      .first<{ s: string | null; p: string | null; e: number | null }>();
    expect(row).toMatchObject({ s: 'SENTINEL', p: 'SENTINEL', e: -1 });
  });

  it('prunes snapshots older than the window floor', async () => {
    await insertVotingPowerHistory(env.DB, [
      { drepId: 'drepA', epoch: 535, amount: '1' },
      { drepId: 'drepA', epoch: 536, amount: '2' },
    ]);
    const { koios } = fakeKoios({ 540: { drepA: '150' } });

    const res = await syncDrepVotingPowerHistory({ koios, db: env.DB, currentEpoch: 540, windowSize: 4 });

    // Window floor is 537, so 535 and 536 are pruned.
    expect(res.pruned).toBe(2);
    const epochs = [...(await getStoredEpochs(env.DB))].sort((a, b) => a - b);
    expect(epochs.every((e) => e >= 537)).toBe(true);
  });

  it('stamps observed delegator counts for the current epoch even when nothing was fetched', async () => {
    await insertVotingPowerHistory(env.DB, [{ drepId: 'drep_stamp_sync', epoch: 950, amount: '100' }]);

    const r = await syncDrepVotingPowerHistory({
      koios: { drepVotingPowerHistory: async () => [] },
      db: env.DB,
      currentEpoch: 950,
      windowSize: 1,
      observedDelegatorCounts: new Map([['drep_stamp_sync', 11]]),
    });
    expect(r.stamped).toBe(1);

    const row = await env.DB.prepare(
      'SELECT delegator_count FROM drep_voting_power_history WHERE drep_id = ? AND epoch = ?',
    )
      .bind('drep_stamp_sync', 950)
      .first<{ delegator_count: number | null }>();
    expect(row?.delegator_count).toBe(11);
  });
});

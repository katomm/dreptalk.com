// DRep voting-power-history D1 access -- run in real workerd via the pool.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getStoredEpochs,
  insertVotingPowerHistory,
  pruneVotingPowerHistoryBefore,
  getDrepVotingPowerSeries,
  denormalizeDrepVotingPower,
  stampDelegatorCounts,
} from './drepVotingPowerHistory.js';

// Minimal dreps row: only the NOT NULL columns plus voting_power.
async function seedDrep(drepId: string, votingPower: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dreps (drep_id, status, voting_power, last_synced_at, created_at)
     VALUES (?, 'registered', ?, 0, 0)`,
  )
    .bind(drepId, votingPower)
    .run();
}

async function readCount(drepId: string, epoch: number) {
  return env.DB.prepare(
    'SELECT delegator_count FROM drep_voting_power_history WHERE drep_id = ? AND epoch = ?',
  )
    .bind(drepId, epoch)
    .first<{ delegator_count: number | null }>();
}

async function readSnapshotCols(drepId: string) {
  return env.DB.prepare(
    'SELECT voting_power_snapshot AS snap, voting_power_prev AS prev, voting_power_snapshot_epoch AS ep FROM dreps WHERE drep_id = ?',
  )
    .bind(drepId)
    .first<{ snap: string | null; prev: string | null; ep: number | null }>();
}

describe('drep voting power history store', () => {
  it('inserts rows and lists the distinct stored epochs', async () => {
    await insertVotingPowerHistory(env.DB, [
      { drepId: 'drepA', epoch: 539, amount: '100' },
      { drepId: 'drepB', epoch: 539, amount: '200' },
      { drepId: 'drepA', epoch: 540, amount: '150' },
    ]);

    const epochs = await getStoredEpochs(env.DB);
    expect([...epochs].sort((a, b) => a - b)).toEqual([539, 540]);
  });

  it('is idempotent on the (drep_id, epoch) key', async () => {
    await insertVotingPowerHistory(env.DB, [{ drepId: 'drepA', epoch: 540, amount: '150' }]);
    // Re-inserting the same key with a different amount must not throw or change it.
    await insertVotingPowerHistory(env.DB, [{ drepId: 'drepA', epoch: 540, amount: '999' }]);

    const series = await getDrepVotingPowerSeries(env.DB, 'drepA');
    expect(series).toEqual([{ epoch: 540, amount: '150' }]);
  });

  it('returns a per-drep series ordered by epoch ascending', async () => {
    await insertVotingPowerHistory(env.DB, [
      { drepId: 'drepA', epoch: 540, amount: '150' },
      { drepId: 'drepA', epoch: 538, amount: '90' },
      { drepId: 'drepA', epoch: 539, amount: '100' },
      { drepId: 'drepB', epoch: 540, amount: '999' },
    ]);

    const series = await getDrepVotingPowerSeries(env.DB, 'drepA');
    expect(series).toEqual([
      { epoch: 538, amount: '90' },
      { epoch: 539, amount: '100' },
      { epoch: 540, amount: '150' },
    ]);
  });

  it('prunes epochs below the floor and reports the deleted count', async () => {
    await insertVotingPowerHistory(env.DB, [
      { drepId: 'drepA', epoch: 537, amount: '1' },
      { drepId: 'drepA', epoch: 538, amount: '2' },
      { drepId: 'drepA', epoch: 539, amount: '3' },
    ]);

    const deleted = await pruneVotingPowerHistoryBefore(env.DB, 539);
    expect(deleted).toBe(2);
    expect(await getDrepVotingPowerSeries(env.DB, 'drepA')).toEqual([{ epoch: 539, amount: '3' }]);
  });

  it('denormalizes the latest two snapshots onto the dreps row', async () => {
    await seedDrep('drepA', '150');
    await seedDrep('drepB', '150'); // only has the current epoch
    await insertVotingPowerHistory(env.DB, [
      { drepId: 'drepA', epoch: 539, amount: '100' },
      { drepId: 'drepA', epoch: 540, amount: '150' },
      { drepId: 'drepB', epoch: 540, amount: '150' },
    ]);

    await denormalizeDrepVotingPower(env.DB, 540);

    const a = await readSnapshotCols('drepA');
    expect(a).toMatchObject({ snap: '150', prev: '100', ep: 540 });

    // drepB has no epoch-539 row, so prev stays null (no delta chip for it).
    const b = await readSnapshotCols('drepB');
    expect(b).toMatchObject({ snap: '150', prev: null, ep: 540 });
  });

  it('leaves snapshot null for a drep absent from the current epoch', async () => {
    await seedDrep('drepGone', '0');
    await insertVotingPowerHistory(env.DB, [{ drepId: 'drepGone', epoch: 538, amount: '5' }]);

    await denormalizeDrepVotingPower(env.DB, 540);

    const row = await readSnapshotCols('drepGone');
    expect(row).toMatchObject({ snap: null, prev: null, ep: 540 });
  });
});

describe('stampDelegatorCounts', () => {
  it('stamps observed counts and never the stale dreps column', async () => {
    // The dreps row carries a (possibly stale) count, but only drep_stamp_x
    // was observed this run: drep_stamp_a must stay NULL.
    await seedDrep('drep_stamp_a', '100');
    await env.DB.prepare('UPDATE dreps SET delegator_count = 99 WHERE drep_id = ?')
      .bind('drep_stamp_a')
      .run();
    await insertVotingPowerHistory(env.DB, [
      { drepId: 'drep_stamp_a', epoch: 900, amount: '100' },
      { drepId: 'drep_stamp_x', epoch: 900, amount: '50' },
    ]);

    const stamped = await stampDelegatorCounts(env.DB, 900, new Map([['drep_stamp_x', 5]]));
    expect(stamped).toBe(1);
    expect((await readCount('drep_stamp_x', 900))?.delegator_count).toBe(5);
    expect((await readCount('drep_stamp_a', 900))?.delegator_count).toBeNull();
  });

  it('stamps once and never overwrites', async () => {
    await insertVotingPowerHistory(env.DB, [{ drepId: 'drep_stamp_b', epoch: 901, amount: '100' }]);
    await stampDelegatorCounts(env.DB, 901, new Map([['drep_stamp_b', 7]]));
    const again = await stampDelegatorCounts(env.DB, 901, new Map([['drep_stamp_b', 9]]));
    expect(again).toBe(0);
    expect((await readCount('drep_stamp_b', 901))?.delegator_count).toBe(7);
  });

  it('retries per DRep: a later pass fills what an earlier one could not', async () => {
    await insertVotingPowerHistory(env.DB, [
      { drepId: 'drep_stamp_c', epoch: 902, amount: '100' },
      { drepId: 'drep_stamp_d', epoch: 902, amount: '100' },
    ]);
    await stampDelegatorCounts(env.DB, 902, new Map([['drep_stamp_c', 3]]));
    expect((await readCount('drep_stamp_d', 902))?.delegator_count).toBeNull();
    await stampDelegatorCounts(env.DB, 902, new Map([['drep_stamp_d', 4]]));
    expect((await readCount('drep_stamp_c', 902))?.delegator_count).toBe(3);
    expect((await readCount('drep_stamp_d', 902))?.delegator_count).toBe(4);
  });

  it('ignores observations without a history row and other epochs', async () => {
    await insertVotingPowerHistory(env.DB, [{ drepId: 'drep_stamp_e', epoch: 903, amount: '100' }]);
    const stamped = await stampDelegatorCounts(
      env.DB,
      904,
      new Map([
        ['drep_stamp_e', 6],
        ['drep_stamp_ghost', 1],
      ]),
    );
    expect(stamped).toBe(0);
    expect((await readCount('drep_stamp_e', 903))?.delegator_count).toBeNull();
  });
});

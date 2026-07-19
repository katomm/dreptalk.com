// getDrepRanking + getDrepMoverStanding against the real miniflare D1 binding.
// These back the pinned "this is you" rows on the directory and movers pages, so
// the tests pin down rank/total exactly, including the tricky NULLS-last delegator
// sort and the sign-split mover ranking (where bind order is easy to get wrong).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getDrepRanking, getDrepMoverStanding } from './dreps.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';

const db = () => env.DB;

async function seed(opts: {
  id: string;
  power?: string;
  snapshot?: string | null;
  prev?: string | null;
  epoch?: number | null;
  delegators?: number | null;
  active?: boolean;
}): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO dreps (drep_id, status, active, voting_power,
          voting_power_snapshot, voting_power_prev, voting_power_snapshot_epoch,
          delegator_count, last_synced_at, created_at)
       VALUES (?, 'registered', ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .bind(
      opts.id,
      opts.active === false ? 0 : 1,
      opts.power ?? '0',
      opts.snapshot ?? null,
      opts.prev ?? null,
      opts.epoch ?? null,
      opts.delegators ?? null,
    )
    .run();
}

describe('getDrepRanking', () => {
  it('ranks by voting power within the active listing', async () => {
    await seed({ id: 'r_big', power: '300' });
    await seed({ id: 'r_mid', power: '200' });
    await seed({ id: 'r_low', power: '100' });

    const mid = await getDrepRanking(db(), 'r_mid', { activeOnly: true, sort: 'power' });
    expect(mid).not.toBeNull();
    expect(mid!.rank).toBe(2);
    expect(mid!.total).toBe(3);
    expect(mid!.drep.drepId).toBe('r_mid');

    const big = await getDrepRanking(db(), 'r_big', { activeOnly: true, sort: 'power' });
    expect(big!.rank).toBe(1);
  });

  it('gives an inactive DRep no rank under an active-only view, but ranks it when showing all', async () => {
    await seed({ id: 'r_a', power: '300' });
    await seed({ id: 'r_b', power: '200' });
    await seed({ id: 'r_off', power: '250', active: false });

    const activeOnly = await getDrepRanking(db(), 'r_off', { activeOnly: true, sort: 'power' });
    expect(activeOnly!.rank).toBeNull();
    expect(activeOnly!.total).toBe(2); // the two active DReps

    const all = await getDrepRanking(db(), 'r_off', { activeOnly: false, sort: 'power' });
    expect(all!.total).toBe(3);
    expect(all!.rank).toBe(2); // 250 sits between 300 and 200
  });

  it('ranks by delegator count under the delegator sort, with the power tie-break', async () => {
    await seed({ id: 'd_top', power: '10', delegators: 30 });
    await seed({ id: 'd_mid', power: '10', delegators: 10 });
    await seed({ id: 'd_low', power: '10', delegators: 5 });

    const mid = await getDrepRanking(db(), 'd_mid', { activeOnly: true, sort: 'delegators' });
    expect(mid!.rank).toBe(2);
    expect(mid!.total).toBe(3);
  });

  it('breaks a delegator tie by voting power', async () => {
    await seed({ id: 't_hi', power: '900', delegators: 10 });
    await seed({ id: 't_lo', power: '100', delegators: 10 });

    const lo = await getDrepRanking(db(), 't_lo', { activeOnly: true, sort: 'delegators' });
    expect(lo!.rank).toBe(2); // same delegators, less power -> behind t_hi
  });

  it('gives a never-counted DRep no rank under the delegator sort', async () => {
    await seed({ id: 'n_a', power: '10', delegators: 30 });
    await seed({ id: 'n_null', power: '10', delegators: null });

    const nullOne = await getDrepRanking(db(), 'n_null', { activeOnly: true, sort: 'delegators' });
    expect(nullOne!.rank).toBeNull();
    expect(nullOne!.total).toBe(2);
  });

  it('returns a null rank for a special pseudo-DRep and null for an unknown DRep', async () => {
    await seed({ id: SPECIAL_DREP_IDS[0], power: '999' });
    const special = await getDrepRanking(db(), SPECIAL_DREP_IDS[0], { activeOnly: true, sort: 'power' });
    expect(special!.rank).toBeNull();

    const missing = await getDrepRanking(db(), 'does_not_exist', { activeOnly: true, sort: 'power' });
    expect(missing).toBeNull();
  });
});

describe('getDrepMoverStanding', () => {
  it('ranks a gainer among gainers by delta magnitude', async () => {
    await seed({ id: 'm_up1', snapshot: '1500', prev: '1000', epoch: 500 }); // +500
    await seed({ id: 'm_up2', snapshot: '1300', prev: '1000', epoch: 500 }); // +300 (self)
    await seed({ id: 'm_up3', snapshot: '1100', prev: '1000', epoch: 500 }); // +100
    await seed({ id: 'm_dn1', snapshot: '600', prev: '1000', epoch: 500 }); // -400

    const self = await getDrepMoverStanding(db(), 'm_up2');
    expect(self).not.toBeNull();
    expect(self!.direction).toBe('up');
    expect(self!.rank).toBe(2); // behind m_up1's +500
    expect(self!.total).toBe(3); // three gainers
    expect(self!.epoch).toBe(500);
  });

  it('ranks a loser among losers by loss magnitude', async () => {
    await seed({ id: 'l_big', snapshot: '400', prev: '1000', epoch: 500 }); // -600
    await seed({ id: 'l_small', snapshot: '900', prev: '1000', epoch: 500 }); // -100
    await seed({ id: 'l_gain', snapshot: '1200', prev: '1000', epoch: 500 }); // +200

    const big = await getDrepMoverStanding(db(), 'l_big');
    expect(big!.direction).toBe('down');
    expect(big!.rank).toBe(1); // biggest loss leads
    expect(big!.total).toBe(2); // two losers

    const small = await getDrepMoverStanding(db(), 'l_small');
    expect(small!.rank).toBe(2);
  });

  it('reports flat with no rank when the snapshot is unchanged', async () => {
    await seed({ id: 'f_flat', snapshot: '1000', prev: '1000', epoch: 500 });
    const flat = await getDrepMoverStanding(db(), 'f_flat');
    expect(flat!.direction).toBe('flat');
    expect(flat!.rank).toBeNull();
    expect(flat!.total).toBe(0);
    expect(flat!.epoch).toBe(500);
  });

  it('reports flat with no rank when a snapshot is missing', async () => {
    await seed({ id: 'f_new', snapshot: '1000', prev: null, epoch: 500 });
    const s = await getDrepMoverStanding(db(), 'f_new');
    expect(s!.direction).toBe('flat');
    expect(s!.rank).toBeNull();
  });

  it('returns null for an unknown DRep', async () => {
    expect(await getDrepMoverStanding(db(), 'nope')).toBeNull();
  });
});

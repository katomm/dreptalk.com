// The ordering queries behind the DRep list: one light read of the ordering
// columns, and the full rows of a page of ids in the order given.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listDrepOrderRows, getDrepOrderRow, getDrepsInOrder } from './dreps.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';

const db = () => env.DB;

async function seedDrep(opts: {
  id: string;
  name?: string | null;
  power?: string;
  active?: boolean;
  doNotList?: boolean;
}): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO dreps (drep_id, status, active, name, voting_power, do_not_list, last_synced_at, created_at)
       VALUES (?, 'registered', ?, ?, ?, ?, 0, 0)`,
    )
    .bind(
      opts.id,
      opts.active === false ? 0 : 1,
      opts.name ?? null,
      opts.power ?? '0',
      opts.doNotList ? 1 : 0,
    )
    .run();
}

async function seedCard(opts: { id: string; participation: number; rationale: number | null }): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO drep_report_card (drep_id, computed_at, participation_pct, participation_ahead_pct,
          rationale_pct, rationale_ahead_pct, eligible, cohort_size, rationale_cohort_size)
       VALUES (?, 0, ?, 50, ?, 50, 10, 100, 100)`,
    )
    .bind(opts.id, opts.participation, opts.rationale)
    .run();
}

describe('listDrepOrderRows', () => {
  it('returns the ordering columns with report card values', async () => {
    await seedDrep({ id: 'o_a', name: 'Alice', power: '30000000000' });
    await seedCard({ id: 'o_a', participation: 82.5, rationale: 40 });
    const rows = await listDrepOrderRows(db(), { activeOnly: true });
    expect(rows.find((r) => r.drepId === 'o_a')).toEqual({
      drepId: 'o_a',
      active: true,
      hasName: true,
      votingPower: '30000000000',
      doNotList: false,
      participationPct: 82.5,
      rationalePct: 40,
    });
  });
  it('treats a missing and an empty name as no name, and a missing card as null', async () => {
    await seedDrep({ id: 'o_null', name: null });
    await seedDrep({ id: 'o_empty', name: '' });
    const rows = await listDrepOrderRows(db(), { activeOnly: true });
    for (const id of ['o_null', 'o_empty']) {
      const r = rows.find((x) => x.drepId === id)!;
      expect(r.hasName).toBe(false);
      expect(r.participationPct).toBeNull();
      expect(r.rationalePct).toBeNull();
    }
  });
  it('reads active from dreps, also when a stale report card row exists', async () => {
    await seedDrep({ id: 'o_retired', name: 'Gone', active: false });
    await seedCard({ id: 'o_retired', participation: 99, rationale: 99 });
    expect((await listDrepOrderRows(db(), { activeOnly: true })).some((r) => r.drepId === 'o_retired')).toBe(false);
    const all = await listDrepOrderRows(db(), {});
    expect(all.find((r) => r.drepId === 'o_retired')!.active).toBe(false);
  });
  it('never returns the predefined options', async () => {
    for (const id of SPECIAL_DREP_IDS) await seedDrep({ id, name: null, power: '999999999999999' });
    const ids = (await listDrepOrderRows(db(), {})).map((r) => r.drepId);
    for (const id of SPECIAL_DREP_IDS) expect(ids).not.toContain(id);
  });
  it('reports do_not_list', async () => {
    await seedDrep({ id: 'o_dnl', name: 'Shy', doNotList: true });
    expect((await listDrepOrderRows(db(), {})).find((r) => r.drepId === 'o_dnl')!.doNotList).toBe(true);
  });
});

describe('getDrepOrderRow', () => {
  it('returns the row for an inactive DRep and null for an unknown id', async () => {
    await seedDrep({ id: 'o_one', name: 'One', active: false });
    expect((await getDrepOrderRow(db(), 'o_one'))!.active).toBe(false);
    expect(await getDrepOrderRow(db(), 'o_missing')).toBeNull();
  });
});

describe('getDrepsInOrder', () => {
  it('keeps the order of the ids and skips unknown ones', async () => {
    for (const id of ['g_1', 'g_2', 'g_3']) await seedDrep({ id, name: id });
    const out = await getDrepsInOrder(db(), ['g_3', 'g_missing', 'g_1', 'g_2']);
    expect(out.map((d) => d.drepId)).toEqual(['g_3', 'g_1', 'g_2']);
  });
});

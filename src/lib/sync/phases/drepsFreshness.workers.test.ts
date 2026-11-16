// The unexpired columns of governance_epoch_stats are read from the dreps
// table, so the epoch-stats phase may only trust that table in a run whose
// dreps phase actually refreshed it. These tests pin the hand-over between the
// two phases through the run state: who sets the flag, when it stays false,
// and that the stats phase obeys it.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { drepPhases, initialDrepSyncState, type DrepSyncContext } from './dreps.js';
import { resolveNetwork } from '../../config/network.js';
import type { DrepInfoRow, DrepListRow } from '../../koios/client.js';

const cfg = resolveNetwork('preprod');
const EPOCH = 300;

function listRow(id: string): DrepListRow {
  return { drep_id: id, hex: `${id}-hex`, has_script: false, registered: true };
}

function infoRow(id: string, amount: string, active: boolean): DrepInfoRow {
  return {
    drep_id: id,
    hex: `${id}-hex`,
    has_script: false,
    drep_status: 'registered',
    deposit: '500000000',
    active,
    expires_epoch_no: active ? EPOCH + 10 : EPOCH - 1,
    amount,
    meta_url: null,
    meta_hash: null,
    live_delegator_count: 1,
  };
}

const INFO = new Map<string, DrepInfoRow>([
  ['drep1a', infoRow('drep1a', '600', true)],
  ['drep1b', infoRow('drep1b', '400', true)],
  ['drep1expired', infoRow('drep1expired', '5000', false)],
]);

type KoiosMode = 'ok' | 'empty-list' | 'throws';

function makeCtx(mode: KoiosMode): DrepSyncContext {
  const koios = {
    drepList: async (_limit: number, offset: number): Promise<DrepListRow[]> => {
      if (mode === 'throws') throw new Error('koios down');
      if (mode === 'empty-list' || offset > 0) return [];
      return [...INFO.keys()].map(listRow);
    },
    drepInfoBatch: async (ids: string[]): Promise<DrepInfoRow[]> =>
      ids.map((id) => INFO.get(id)).filter((r): r is DrepInfoRow => r != null),
    totals: async () => ({ treasuryLovelace: '1' }),
  };
  // Only the fields the two phases under test read. A cast, like the other
  // phase tests: the full Koios client and the R2 handles are not needed here.
  return {
    db: env.DB,
    koios,
    cfg,
    now: Date.now(),
    avatars: null,
    downscale: undefined,
    state: initialDrepSyncState(),
  } as unknown as DrepSyncContext;
}

function phase(name: string) {
  const def = drepPhases.find((d) => d.name === name);
  if (!def) throw new Error(`${name} phase is not registered`);
  return def;
}

async function seedSnapshot() {
  for (const [id, row] of INFO) {
    await env.DB.prepare(
      'INSERT INTO drep_voting_power_history (drep_id, epoch, amount) VALUES (?, ?, ?)',
    ).bind(id, EPOCH, row.amount).run();
  }
}

/** The previous run's group, still in the table when this run's sync does not refresh it. */
async function seedStaleDreps() {
  await env.DB.prepare(
    `INSERT INTO dreps (drep_id, status, active, voting_power, last_synced_at, created_at)
     VALUES ('drep1old', 'registered', 1, '777', 0, 0)`,
  ).run();
}

async function unexpiredCount() {
  const row = await env.DB.prepare(
    'SELECT unexpired_drep_count AS n, unexpired_drep_power AS p FROM governance_epoch_stats WHERE epoch = ?',
  ).bind(EPOCH).first<{ n: number | null; p: string | null }>();
  return row;
}

async function runStats(ctx: DrepSyncContext) {
  // The history phase is not under test: its result is the epoch on the state.
  ctx.state.vpHistoryEpoch = EPOCH;
  return phase('epoch-stats').run(ctx);
}

describe('dreps phase to epoch-stats phase hand-over', () => {
  it('starts every run as not fresh', () => {
    expect(initialDrepSyncState().drepsFresh).toBe(false);
  });

  it('a completed DRep sync marks the run fresh and the stats row takes the synced group', async () => {
    await seedSnapshot();
    const ctx = makeCtx('ok');
    await phase('dreps').run(ctx);
    expect(ctx.state.drepsFresh).toBe(true);

    await runStats(ctx);
    // drep1a and drep1b are active, drep1expired is not.
    expect(await unexpiredCount()).toEqual({ n: 2, p: '1000' });
  });

  it('a throwing DRep sync leaves the run not fresh and the stale table is not written as an observation', async () => {
    await seedSnapshot();
    await seedStaleDreps();
    const ctx = makeCtx('throws');
    await expect(phase('dreps').run(ctx)).rejects.toThrow('koios down');
    expect(ctx.state.drepsFresh).toBe(false);

    await runStats(ctx);
    expect(await unexpiredCount()).toEqual({ n: null, p: null });
  });

  it('an empty DRep enumeration is no observation, even though the sync returns normally', async () => {
    await seedSnapshot();
    await seedStaleDreps();
    const ctx = makeCtx('empty-list');
    await phase('dreps').run(ctx);
    expect(ctx.state.drepsFresh).toBe(false);

    await runStats(ctx);
    expect(await unexpiredCount()).toEqual({ n: null, p: null });
  });
});

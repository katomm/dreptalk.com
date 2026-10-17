/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { loadPoolEconomics, readPoolEconomics, syncPoolEconomics, type PoolEconomicsKoios } from './poolEconomics.js';
import { epochStartUnix } from '../config/network.js';

const preprodCfg = { network: 'preprod', networkId: 0, epochAnchor: { epoch: 300, unixSeconds: 1_790_000_000 } } as never;
// One hour into the given epoch on the stub network, in unix ms.
const nowIn = (epoch: number) => (epochStartUnix(epoch, preprodCfg) + 3600) * 1000;

function page(n: number, stake = '2000000000') {
  return Array.from({ length: n }, () => ({ active_stake: stake, pledge: '1000000000', fixed_cost: '170000001' }));
}

function koios(over: Partial<PoolEconomicsKoios> = {}, totalsEpoch = 300): PoolEconomicsKoios & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    poolList: async (offset) => {
      calls.push(`pools:${offset}`);
      return offset === 0 ? page(1000) : offset === 1000 ? [...page(2, '0'), ...page(3, '5000000000')] : [];
    },
    totals: async () => {
      calls.push('totals');
      return {
        epochNo: totalsEpoch,
        treasuryLovelace: '1',
        reservesLovelace: '6000000000000000',
        circulationLovelace: null,
        supplyLovelace: '39000000000000000',
        feesLovelace: '5',
      };
    },
    ...over,
  };
}

const rows = () => env.DB.prepare('SELECT epoch, body, computed_at FROM pool_economics ORDER BY epoch').all<{ epoch: number; body: string; computed_at: number }>();
const run = (k: PoolEconomicsKoios, epoch: number) => syncPoolEconomics({ db: env.DB, koios: k, cfg: preprodCfg, now: nowIn(epoch) });

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM pool_economics').run();
});

describe('readPoolEconomics', () => {
  it('pages the pool list, drops pools without stake and sorts by stake', async () => {
    const k = koios();
    const json = await readPoolEconomics(k);
    expect(json?.epoch).toBe(300);
    expect(json?.pools).toHaveLength(1003);
    expect(json?.pools[0]).toEqual([5000, 1000, '170000001']);
    expect(json?.supplyLovelace).toBe('39000000000000000');
    expect(k.calls).toEqual(['pools:0', 'pools:1000', 'totals']);
  });

  it('keeps the fixed cost exact in lovelace', async () => {
    const json = await readPoolEconomics(koios());
    expect(json?.pools.every((p) => p[2] === '170000001')).toBe(true);
  });

  it('is null instead of a truncated list after 20 full pages', async () => {
    expect(await readPoolEconomics(koios({ poolList: async () => page(1000) }))).toBeNull();
  });

  it('is null when the totals carry no supply', async () => {
    const k = koios({ totals: async () => ({ epochNo: 300, reservesLovelace: '1', supplyLovelace: null }) });
    expect(await readPoolEconomics(k)).toBeNull();
  });
});

describe('syncPoolEconomics', () => {
  it('writes the distribution of a new epoch and keeps only the newest row', async () => {
    expect(await run(koios({}, 300), 300)).toMatchObject({ written: 1, failed: 0 });
    expect(await run(koios({}, 301), 301)).toMatchObject({ written: 1, failed: 0 });
    const { results } = await rows();
    expect(results).toHaveLength(1);
    expect(results[0].epoch).toBe(301);
    expect(results[0].body).toBe(JSON.stringify(await readPoolEconomics(koios({}, 301))));
    expect(await loadPoolEconomics(env.DB)).toEqual({ epoch: 301, body: results[0].body });
  });

  it('skips Koios when the epoch is already stored', async () => {
    await run(koios(), 300);
    const k = koios();
    expect(await run(k, 300)).toMatchObject({ written: 0, failed: 0 });
    expect(k.calls).toEqual([]);
  });

  it('does not store a lagging epoch', async () => {
    expect(await run(koios({}, 299), 300)).toMatchObject({ written: 0, failed: 0 });
    expect((await rows()).results).toHaveLength(0);
  });

  it('fails the phase on a Koios error without writing', async () => {
    const failing = koios({ poolList: async () => { throw new Error('502'); } });
    await expect(run(failing, 300)).rejects.toThrow('502');
    expect((await rows()).results).toHaveLength(0);
  });

  it('keeps the stored row when the read returns null', async () => {
    await run(koios({}, 300), 300);
    const before = (await rows()).results;
    expect(await run(koios({ poolList: async () => page(1000) }), 301)).toMatchObject({ written: 0, failed: 1 });
    const noSupply = koios({ totals: async () => ({ epochNo: 301, reservesLovelace: '1', supplyLovelace: null }) });
    expect(await run(noSupply, 301)).toMatchObject({ written: 0, failed: 1 });
    expect((await rows()).results).toEqual(before);
  });
});

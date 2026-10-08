/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handlePoolEconomics, type PoolEconomicsKoios } from './poolEconomicsHandler.js';
import { epochStartUnix } from '@/lib/config/network.js';

const preprodCfg = { network: 'preprod', networkId: 0, epochAnchor: { epoch: 300, unixSeconds: 1_790_000_000 } } as never;
const mainnetCfg = { network: 'mainnet', networkId: 1, epochAnchor: { epoch: 600, unixSeconds: 1_790_000_000 } } as never;
const testEnv = { ...env } as Cloudflare.Env;
// One hour into epoch 300 on the stub network.
const NOW = () => (epochStartUnix(300, preprodCfg) + 3600) * 1000;

function ctx() {
  const request = new Request('https://dreptalk.com/api/gov-action/pool-economics', {
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  return { request, locals: { user: { id: 'u1', roles: [] } } as App.Locals };
}

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

async function freshCache() {
  return caches.open(`pool-econ-test-${crypto.randomUUID()}`);
}

const deps = (k: PoolEconomicsKoios, cache: Cache, network = preprodCfg) => ({ koios: k, network, env: testEnv, cache, now: NOW });

describe('handlePoolEconomics', () => {
  it('pages the pool list, drops pools without stake and sorts by stake', async () => {
    const k = koios();
    const res = await handlePoolEconomics(ctx(), deps(k, await freshCache()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { epoch: number; pools: [number, number, string][]; supplyLovelace: string };
    expect(json.epoch).toBe(300);
    expect(json.pools).toHaveLength(1003);
    expect(json.pools[0]).toEqual([5000, 1000, '170000001']);
    expect(json.supplyLovelace).toBe('39000000000000000');
    expect(k.calls).toEqual(['pools:0', 'pools:1000', 'totals']);
  });

  it('serves the second request of an epoch from the cache', async () => {
    const cache = await freshCache();
    await handlePoolEconomics(ctx(), deps(koios(), cache));
    const k = koios();
    const res = await handlePoolEconomics(ctx(), deps(k, cache));
    expect(res.status).toBe(200);
    expect(k.calls).toEqual([]);
  });

  it('labels data with the totals epoch and does not cache it while Koios lags behind the clock', async () => {
    const cache = await freshCache();
    const lagging = await handlePoolEconomics(ctx(), deps(koios({}, 299), cache));
    expect(((await lagging.json()) as { epoch: number }).epoch).toBe(299);
    const k = koios();
    await handlePoolEconomics(ctx(), deps(k, cache));
    expect(k.calls).toContain('totals');
  });

  it('answers 503 pool_data_unavailable when Koios fails', async () => {
    const failing = koios({ poolList: async () => { throw new Error('502'); } });
    const res = await handlePoolEconomics(ctx(), deps(failing, await freshCache()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'pool_data_unavailable' });
  });

  it('is 404 on mainnet before any Koios read', async () => {
    const k = koios();
    const res = await handlePoolEconomics(ctx(), deps(k, await freshCache(), mainnetCfg));
    expect(res.status).toBe(404);
    expect(k.calls).toEqual([]);
  });

  it('answers 503 instead of a truncated list after 20 full pages', async () => {
    const res = await handlePoolEconomics(ctx(), deps(koios({ poolList: async () => page(1000) }), await freshCache()));
    expect(res.status).toBe(503);
  });
});

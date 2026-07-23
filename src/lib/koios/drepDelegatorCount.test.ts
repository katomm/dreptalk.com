import { describe, it, expect } from 'vitest';
import { createKoiosClient } from './client.js';

const BASE = 'https://api.koios.rest/api/v1';

const infoRow = (drepId: string, liveDelegatorCount: number | null) => ({
  drep_id: drepId,
  hex: `${drepId}-hex`,
  has_script: false,
  drep_status: 'active',
  deposit: '500000000',
  active: true,
  expires_epoch_no: 400,
  amount: '1000000000',
  meta_url: null,
  meta_hash: null,
  live_delegator_count: liveDelegatorCount,
});

describe('koios.drepDelegatorCount', () => {
  it('POSTs the drep id to /drep_info and returns live_delegator_count', async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify([infoRow('drep1abc', 1659)]), { status: 200 });
    }) as unknown as typeof fetch;

    const koios = createKoiosClient({ baseUrl: BASE, fetchImpl });
    const count = await koios.drepDelegatorCount('drep1abc');

    expect(count).toBe(1659);
    expect(seenUrl).toBe(`${BASE}/drep_info`);
    expect(seenBody).toEqual({ _drep_ids: ['drep1abc'] });
  });

  it('returns a zero count as 0, not null', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify([infoRow('drep1abc', 0)]), { status: 200 })) as unknown as typeof fetch;
    const koios = createKoiosClient({ baseUrl: BASE, fetchImpl });
    expect(await koios.drepDelegatorCount('drep1abc')).toBe(0);
  });

  it('returns null when the DRep is absent from the response', async () => {
    const fetchImpl = (async () =>
      new Response('[]', { status: 200 })) as unknown as typeof fetch;
    const koios = createKoiosClient({ baseUrl: BASE, fetchImpl });
    expect(await koios.drepDelegatorCount('drep1abc')).toBeNull();
  });

  it('returns null when Koios omits live_delegator_count', async () => {
    const { live_delegator_count: _omit, ...withoutCount } = infoRow('drep1abc', 0);
    const fetchImpl = (async () =>
      new Response(JSON.stringify([withoutCount]), { status: 200 })) as unknown as typeof fetch;
    const koios = createKoiosClient({ baseUrl: BASE, fetchImpl });
    expect(await koios.drepDelegatorCount('drep1abc')).toBeNull();
  });
});

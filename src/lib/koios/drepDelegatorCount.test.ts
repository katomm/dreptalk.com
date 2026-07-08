import { describe, it, expect } from 'vitest';
import { createKoiosClient } from './client.js';

const BASE = 'https://api.koios.rest/api/v1';

describe('koios.drepDelegatorCount', () => {
  it('sends Prefer: count=exact and returns the Content-Range total', async () => {
    let seenUrl = '';
    let seenPrefer = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenPrefer = (init.headers as Record<string, string>).Prefer;
      return new Response('[{"stake_address":"stake1abc"}]', {
        status: 206,
        headers: { 'content-range': '0-0/1659' },
      });
    }) as unknown as typeof fetch;

    const koios = createKoiosClient({ baseUrl: BASE, fetchImpl });
    const count = await koios.drepDelegatorCount('drep1abc');

    expect(count).toBe(1659);
    expect(seenUrl).toBe(`${BASE}/drep_delegators?_drep_id=drep1abc&limit=1`);
    expect(seenPrefer).toBe('count=exact');
  });

  it('returns null when the count header is missing', async () => {
    const fetchImpl = (async () =>
      new Response('[]', { status: 200 })) as unknown as typeof fetch;
    const koios = createKoiosClient({ baseUrl: BASE, fetchImpl });
    expect(await koios.drepDelegatorCount('drep1abc')).toBeNull();
  });
});

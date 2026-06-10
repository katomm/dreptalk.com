import { describe, it, expect } from 'vitest';
import { createKoiosClient } from './client.js';

describe('koios.drepUpdates', () => {
  it('parses update rows and sends pagination params, no _drep_id filter', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return new Response(
        JSON.stringify([
          { drep_id: 'drep1', action: 'registered', block_time: 1700000000 },
          { drep_id: 'drep1', action: 'updated', block_time: 1700500000 },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const koios = createKoiosClient({ baseUrl: 'https://x/api/v1', fetchImpl });
    const rows = await koios.drepUpdates(1000, 0);

    expect(calledUrl).toBe('https://x/api/v1/drep_updates?limit=1000&offset=0');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ drep_id: 'drep1', action: 'registered', block_time: 1700000000 });
  });
});

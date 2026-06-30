import { describe, expect, it, vi } from 'vitest';
import { createKoiosClient } from './client.js';

describe('poolInfoBatch', () => {
  it('parses pool_info rows and posts the bech32 ids', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            pool_id_bech32: 'pool1a',
            pool_id_hex: 'aa',
            meta_url: 'https://m',
            meta_hash: 'h',
            meta_json: { ticker: 'COOL', name: 'Stake Cool' },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const koios = createKoiosClient({ baseUrl: 'https://koios.test', fetchImpl });
    const rows = await koios.poolInfoBatch(['pool1a']);
    expect(rows[0].meta_json?.ticker).toBe('COOL');
    expect(rows[0].pool_id_hex).toBe('aa');
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body._pool_bech32_ids).toEqual(['pool1a']);
  });

  it('short-circuits on empty input', async () => {
    const fetchImpl = vi.fn();
    const koios = createKoiosClient({ baseUrl: 'https://koios.test', fetchImpl });
    expect(await koios.poolInfoBatch([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

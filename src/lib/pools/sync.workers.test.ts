import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getPoolsByIds } from '../db/pools.js';
import { syncPools } from './sync.js';

describe('syncPools', () => {
  it('writes ticker/name and resolves a logo via the extended chain', async () => {
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, local_status)
       VALUES ('ga1','SPO','pool1a','Yes',1,'onchain')`,
    ).run();

    const koios = {
      poolInfoBatch: async () => [
        {
          pool_id_bech32: 'pool1a', pool_id_hex: 'aa',
          meta_url: 'https://m/base.json', meta_hash: 'h1',
          meta_json: { ticker: 'COOL', name: 'Stake Cool' },
        },
      ],
    };
    // base doc points to extended; extended carries the icon.
    const fetchImpl = (async (url: string) => {
      if (url === 'https://m/base.json')
        return new Response('{"name":"Stake Cool","extended":"https://m/ext.json"}', { status: 200 });
      return new Response('{"info":{"url_png_icon_64x64":"https://m/64.png"}}', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await syncPools({ koios, db: env.DB, fetchImpl, nowMs: 5 });
    expect(res.updated).toBe(1);
    expect(res.logos).toBe(1);
    const pool = (await getPoolsByIds(env.DB, ['pool1a'])).get('pool1a');
    expect(pool?.ticker).toBe('COOL');
    // image_url is set so the avatar pass will pick it up (verify via a raw read).
    const raw = await env.DB.prepare('SELECT image_url FROM pools WHERE pool_id = ?')
      .bind('pool1a').first<{ image_url: string }>();
    expect(raw?.image_url).toBe('https://m/64.png');
  });
});

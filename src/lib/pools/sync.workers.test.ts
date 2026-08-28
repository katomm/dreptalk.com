import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getPoolsByIds, upsertPoolMeta } from '../db/pools.js';
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

  it('falls back to the off-chain document when Koios has no meta_json', async () => {
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, local_status)
       VALUES ('ga1','SPO','pool1b','Yes',1,'onchain')`,
    ).run();

    const koios = {
      poolInfoBatch: async () => [
        {
          pool_id_bech32: 'pool1b', pool_id_hex: 'bb',
          meta_url: 'https://m/clio.json', meta_hash: 'h1',
          meta_json: null,
        },
      ],
    };
    const fetchImpl = (async (url: string) => {
      if (url === 'https://m/clio.json')
        return new Response(
          '{"name":"CLIO1","ticker":"CLIO1","homepage":"https://clio.one","extended":"https://m/ext.json"}',
          { status: 200 },
        );
      return new Response('{"info":{"url_png_icon_64x64":"https://m/64.png"}}', { status: 200 });
    }) as unknown as typeof fetch;

    await syncPools({ koios, db: env.DB, fetchImpl, nowMs: 5 });
    const pool = (await getPoolsByIds(env.DB, ['pool1b'])).get('pool1b');
    expect(pool?.name).toBe('CLIO1');
    expect(pool?.ticker).toBe('CLIO1');
    expect(pool?.homepage).toBe('https://clio.one');
  });

  it('keeps the stored identity when neither source resolves on a later run', async () => {
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, local_status)
       VALUES ('ga1','SPO','pool1c','Yes',1,'onchain')`,
    ).run();
    await upsertPoolMeta(env.DB, {
      poolId: 'pool1c', poolHash: 'cc', ticker: 'COOL', name: 'Stake Cool',
      homepage: null, description: null, metaUrl: 'https://m/named.json', metaHash: 'h1',
      imageUrl: null, syncedAt: 1,
    });

    // Upstream lost its copy and the document itself is unreachable.
    const koios = {
      poolInfoBatch: async () => [
        {
          pool_id_bech32: 'pool1c', pool_id_hex: 'cc',
          meta_url: 'https://m/named.json', meta_hash: 'h1',
          meta_json: null,
        },
      ],
    };
    const failingFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const res = await syncPools({ koios, db: env.DB, fetchImpl: failingFetch, nowMs: 100, refreshMs: 0 });
    expect(res.updated).toBe(1);

    const pool = (await getPoolsByIds(env.DB, ['pool1c'])).get('pool1c');
    expect(pool?.name).toBe('Stake Cool');
    expect(pool?.ticker).toBe('COOL');
  });
});

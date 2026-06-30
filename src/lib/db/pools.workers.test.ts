import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  getPoolsByIds,
  upsertPoolMeta,
  activePoolIdsNeedingSync,
  listPoolsNeedingAvatar,
  setPoolImageStored,
} from './pools.js';

describe('pools table', () => {
  it('round-trips a row', async () => {
    await env.DB.prepare(
      `INSERT INTO pools (pool_id, pool_hash, ticker, name, synced_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('pool1abc', 'deadbeef', 'HEPHY', 'Hephaestus Stake Pool', 1)
      .run();
    const row = await env.DB.prepare('SELECT name, ticker FROM pools WHERE pool_id = ?')
      .bind('pool1abc')
      .first<{ name: string; ticker: string }>();
    expect(row?.name).toBe('Hephaestus Stake Pool');
    expect(row?.ticker).toBe('HEPHY');
  });
});

describe('pools module', () => {
  it('upserts and batch-reads pool identity', async () => {
    await upsertPoolMeta(env.DB, {
      poolId: 'pool1xyz', poolHash: 'aa', ticker: 'COOL', name: 'Stake Cool',
      homepage: 'https://x', description: 'd', metaUrl: 'https://m', metaHash: 'h1',
      imageUrl: 'https://logo.png', syncedAt: 10,
    });
    const map = await getPoolsByIds(env.DB, ['pool1xyz', 'pool1missing']);
    expect(map.get('pool1xyz')?.name).toBe('Stake Cool');
    expect(map.get('pool1xyz')?.ticker).toBe('COOL');
    expect(map.has('pool1missing')).toBe(false);
  });

  it('work-set includes SPO voters and SPO users, excludes fresh pools', async () => {
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, local_status)
       VALUES ('ga1','SPO','pool1voter','Yes',1,'onchain')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO users (id, pool_id, is_spo, role, status, created_at, last_verified_at)
       VALUES ('u1','pool1user',1,'user','active',1,1)`,
    ).run();
    await upsertPoolMeta(env.DB, {
      poolId: 'pool1fresh', poolHash: null, ticker: null, name: null, homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: null, syncedAt: 1_000_000,
    });
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, local_status)
       VALUES ('ga1','SPO','pool1fresh','Yes',1,'onchain')`,
    ).run();
    const ids = await activePoolIdsNeedingSync(env.DB, 50, 999_999);
    expect(ids).toContain('pool1voter');
    expect(ids).toContain('pool1user');
    expect(ids).not.toContain('pool1fresh');
  });

  it('avatar queue surfaces pools with a logo URL and no stored image', async () => {
    await upsertPoolMeta(env.DB, {
      poolId: 'pool1logo', poolHash: 'bb', ticker: null, name: null, homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: 'https://i.png', syncedAt: 1,
    });
    const queue = await listPoolsNeedingAvatar(env.DB, 10, 10);
    expect(queue.find((r) => r.poolId === 'pool1logo')?.imageUrl).toBe('https://i.png');
    await setPoolImageStored(env.DB, 'pool1logo', 'cafebabe', 'https://i.png');
    const after = await listPoolsNeedingAvatar(env.DB, 10, 10);
    expect(after.find((r) => r.poolId === 'pool1logo')).toBeUndefined();
  });
});

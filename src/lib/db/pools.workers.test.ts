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

  it('null incoming identity fields preserve the stored name and ticker', async () => {
    const poolId = 'pool1keep-identity';
    await upsertPoolMeta(env.DB, {
      poolId, poolHash: 'dd', ticker: 'CLIO1', name: 'CLIO1', homepage: 'https://clio.one',
      description: 'd', metaUrl: 'https://m', metaHash: 'h1', imageUrl: null, syncedAt: 1,
    });
    await upsertPoolMeta(env.DB, {
      poolId, poolHash: 'dd', ticker: null, name: null, homepage: null,
      description: null, metaUrl: 'https://m', metaHash: 'h1', imageUrl: null, syncedAt: 2,
    });
    const pool = (await getPoolsByIds(env.DB, [poolId])).get(poolId);
    expect(pool?.name).toBe('CLIO1');
    expect(pool?.ticker).toBe('CLIO1');
    expect(pool?.homepage).toBe('https://clio.one');
    expect(pool?.description).toBe('d');
    const raw = await env.DB.prepare('SELECT synced_at FROM pools WHERE pool_id = ?')
      .bind(poolId).first<{ synced_at: number }>();
    expect(raw?.synced_at).toBe(2);
  });

  it('null incoming imageUrl preserves existing logo and stored columns', async () => {
    const poolId = 'pool1null-logo';
    // Insert with a logo url.
    await upsertPoolMeta(env.DB, {
      poolId, poolHash: 'cc', ticker: 'OLD', name: 'Old Name', homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: 'https://logo.png', syncedAt: 1,
    });
    // Simulate a successful avatar store.
    await setPoolImageStored(env.DB, poolId, 'hash123', 'https://logo.png');
    // Re-sync with null imageUrl (e.g. extended-meta host was temporarily down).
    await upsertPoolMeta(env.DB, {
      poolId, poolHash: 'cc', ticker: 'NEW', name: 'New Name', homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: null, syncedAt: 2,
    });
    const row = await env.DB.prepare(
      'SELECT ticker, image_url, image_content_hash FROM pools WHERE pool_id = ?',
    ).bind(poolId).first<{ ticker: string; image_url: string | null; image_content_hash: string | null }>();
    // Non-image fields should update.
    expect(row?.ticker).toBe('NEW');
    // Image columns must be preserved: logo must not be wiped.
    expect(row?.image_url).toBe('https://logo.png');
    expect(row?.image_content_hash).toBe('hash123');
  });

  it('different non-null imageUrl resets stored image columns', async () => {
    const poolId = 'pool1new-logo';
    await upsertPoolMeta(env.DB, {
      poolId, poolHash: 'dd', ticker: 'T1', name: 'N1', homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: 'https://old.png', syncedAt: 1,
    });
    await setPoolImageStored(env.DB, poolId, 'oldhash', 'https://old.png');
    // Re-sync with a different logo url.
    await upsertPoolMeta(env.DB, {
      poolId, poolHash: 'dd', ticker: 'T2', name: 'N2', homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: 'https://new.png', syncedAt: 2,
    });
    const row = await env.DB.prepare(
      'SELECT image_url, image_content_hash FROM pools WHERE pool_id = ?',
    ).bind(poolId).first<{ image_url: string | null; image_content_hash: string | null }>();
    expect(row?.image_url).toBe('https://new.png');
    // Stored hash must be cleared so the avatar pass re-fetches.
    expect(row?.image_content_hash).toBeNull();
  });

  it('same non-null imageUrl after a store preserves stored image columns', async () => {
    const poolId = 'pool1same-logo';
    await upsertPoolMeta(env.DB, {
      poolId, poolHash: 'ee', ticker: 'TX', name: 'NX', homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: 'https://same.png', syncedAt: 1,
    });
    await setPoolImageStored(env.DB, poolId, 'samehash', 'https://same.png');
    // Re-sync with the exact same logo url.
    await upsertPoolMeta(env.DB, {
      poolId, poolHash: 'ee', ticker: 'TX2', name: 'NX2', homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: 'https://same.png', syncedAt: 2,
    });
    const row = await env.DB.prepare(
      'SELECT image_url, image_content_hash FROM pools WHERE pool_id = ?',
    ).bind(poolId).first<{ image_url: string | null; image_content_hash: string | null }>();
    expect(row?.image_url).toBe('https://same.png');
    // Stored hash must be preserved: same url means no re-fetch needed.
    expect(row?.image_content_hash).toBe('samehash');
  });
});

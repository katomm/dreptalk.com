import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { upsertPoolMeta, getPoolsByIds } from '../db/pools.js';
import { storePoolAvatars } from './avatarStore.js';
import { AVATAR_KEY_PREFIX } from '../dreps/avatarStore.js';

const onePngByte = new Uint8Array([137, 80, 78, 71]).buffer;

describe('storePoolAvatars', () => {
  it('downloads a logo and stores it content-addressed', async () => {
    await upsertPoolMeta(env.DB, {
      poolId: 'pool1pic', poolHash: 'aa', ticker: null, name: null, homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: 'https://host/logo.png', syncedAt: 1,
    });
    const fetchImpl = (async () =>
      new Response(onePngByte, { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    const res = await storePoolAvatars({ db: env.DB, bucket: env.AVATARS, fetchImpl });
    expect(res.stored).toBe(1);
    const pool = (await getPoolsByIds(env.DB, ['pool1pic'])).get('pool1pic');
    expect(pool?.imageContentHash).not.toBeNull();
    const obj = await env.AVATARS.get(`${AVATAR_KEY_PREFIX}${pool?.imageContentHash}`);
    expect(obj).not.toBeNull();
  });

  it('marks a failed fetch without throwing', async () => {
    await upsertPoolMeta(env.DB, {
      poolId: 'pool1bad', poolHash: 'bb', ticker: null, name: null, homepage: null,
      description: null, metaUrl: null, metaHash: null, imageUrl: 'https://host/dead.png', syncedAt: 1,
    });
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const res = await storePoolAvatars({ db: env.DB, bucket: env.AVATARS, fetchImpl });
    expect(res.failed).toBeGreaterThanOrEqual(1);
  });
});

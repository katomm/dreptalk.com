// loadAvatar against the real miniflare R2 binding. The card rasterizer (resvg)
// decodes only PNG and JPEG, so only those are inlined; every other stored format
// must fall back to the identicon or the whole OG card renders to an empty PNG.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { loadAvatar } from './assets.js';
import { AVATAR_KEY_PREFIX } from '../dreps/avatarStore.js';
import { identiconDataUri } from '../identity/identicon.js';

const bucket = () => env.AVATARS as R2Bucket;
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const SEED = 'drep1abcdef';

async function store(hash: string, contentType: string) {
  await bucket().put(AVATAR_KEY_PREFIX + hash, BYTES, { httpMetadata: { contentType } });
}

describe('loadAvatar', () => {
  it('inlines a stored PNG as a data URL', async () => {
    const hash = 'a'.repeat(64);
    await store(hash, 'image/png');
    expect(await loadAvatar(bucket(), SEED, hash)).toMatch(/^data:image\/png;base64,/);
  });

  it('inlines a stored JPEG as a data URL', async () => {
    const hash = 'b'.repeat(64);
    await store(hash, 'image/jpeg');
    expect(await loadAvatar(bucket(), SEED, hash)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('falls back to the identicon for a WebP (resvg cannot decode it)', async () => {
    const hash = 'c'.repeat(64);
    await store(hash, 'image/webp');
    const out = await loadAvatar(bucket(), SEED, hash);
    expect(out).not.toMatch(/^data:image\/webp/);
    expect(out).toBe(identiconDataUri(SEED, 160));
  });

  it('falls back to the identicon for AVIF and GIF', async () => {
    await store('d'.repeat(64), 'image/avif');
    await store('e'.repeat(64), 'image/gif');
    expect(await loadAvatar(bucket(), SEED, 'd'.repeat(64))).toBe(identiconDataUri(SEED, 160));
    expect(await loadAvatar(bucket(), SEED, 'e'.repeat(64))).toBe(identiconDataUri(SEED, 160));
  });

  it('falls back to the identicon on a miss, a missing hash, or no bucket', async () => {
    const identicon = identiconDataUri(SEED, 160);
    expect(await loadAvatar(bucket(), SEED, 'f'.repeat(64))).toBe(identicon);
    expect(await loadAvatar(bucket(), SEED, null)).toBe(identicon);
    expect(await loadAvatar(undefined, SEED, 'a'.repeat(64))).toBe(identicon);
  });
});

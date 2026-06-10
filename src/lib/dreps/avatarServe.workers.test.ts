// Serve-core tests against the real miniflare R2 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { serveAvatar } from './avatarServe.js';
import { AVATAR_KEY_PREFIX } from './avatarStore.js';

const bucket = () => env.AVATARS as R2Bucket;
const HASH = '6'.repeat(64);
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

describe('serveAvatar', () => {
  it('serves a stored object with content-type and an immutable cache header', async () => {
    await bucket().put(AVATAR_KEY_PREFIX + HASH, BYTES, { httpMetadata: { contentType: 'image/webp' } });

    const res = await serveAvatar(bucket(), HASH);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.get('content-length')).toBe(String(BYTES.byteLength));
    expect(res.headers.get('etag')).not.toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it('404s on a miss', async () => {
    expect((await serveAvatar(bucket(), '7'.repeat(64))).status).toBe(404);
  });

  it('404s on a malformed hash without touching the bucket', async () => {
    expect((await serveAvatar(bucket(), 'not-a-hash')).status).toBe(404);
    expect((await serveAvatar(bucket(), `${'8'.repeat(63)}X`)).status).toBe(404);
    expect((await serveAvatar(bucket(), undefined)).status).toBe(404);
  });

  it('404s when the bucket binding is missing', async () => {
    expect((await serveAvatar(undefined, HASH)).status).toBe(404);
  });
});

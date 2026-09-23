// Serve-core tests against the real miniflare R2 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { serveAvatar, serveAvatarThumb } from './avatarServe.js';
import { AVATAR_KEY_PREFIX, thumbAvatarKey, type ImagesLike } from './avatarStore.js';
import { AVATAR_THUMB_EDGE } from '../identity/avatarUrl.js';

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

describe('serveAvatarThumb', () => {
  // A fake Images binding: records calls and returns the given bytes, or throws.
  const fakeImages = (out: Uint8Array | 'fail') => {
    const calls: Array<{ width?: number; format?: string }> = [];
    const images: ImagesLike = {
      input: () => {
        const call: { width?: number; format?: string } = {};
        calls.push(call);
        const t = {
          transform(opts: { width?: number }) {
            call.width = opts.width;
            return t;
          },
          async output(opts: { format: string }) {
            call.format = opts.format;
            if (out === 'fail') throw new Error('transform failed');
            return { response: () => new Response(out) };
          },
        };
        return t;
      },
    };
    return { images, calls };
  };
  const big = (n: number) => new Uint8Array(n).fill(9);
  const collect = () => {
    const pending: Promise<unknown>[] = [];
    return { defer: (p: Promise<unknown>) => void pending.push(p), settle: () => Promise.all(pending) };
  };

  it('encodes a large source once, serves the thumb and stores it for the next request', async () => {
    const hash = 'a1'.repeat(32);
    await bucket().put(AVATAR_KEY_PREFIX + hash, big(20_000), { httpMetadata: { contentType: 'image/webp' } });
    const { images, calls } = fakeImages(big(3_000));
    const { defer, settle } = collect();

    const res = await serveAvatarThumb(bucket(), images, hash, defer);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('content-length')).toBe('3000');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(calls).toEqual([{ width: AVATAR_THUMB_EDGE, format: 'image/webp' }]);
    await settle();
    expect((await bucket().head(thumbAvatarKey(hash)))?.size).toBe(3000);

    // Second request reads the stored thumb and never transforms again.
    const again = await serveAvatarThumb(bucket(), images, hash, defer);
    expect(again.headers.get('content-length')).toBe('3000');
    expect(calls).toHaveLength(1);
  });

  it('keeps a small source as the thumb without a transform', async () => {
    const hash = 'b2'.repeat(32);
    await bucket().put(AVATAR_KEY_PREFIX + hash, BYTES, { httpMetadata: { contentType: 'image/png' } });
    const { images, calls } = fakeImages(big(1));
    const { defer, settle } = collect();

    const res = await serveAvatarThumb(bucket(), images, hash, defer);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(calls).toHaveLength(0);
    await settle();
    expect(await bucket().head(thumbAvatarKey(hash))).not.toBeNull();
  });

  it('keeps an animated GIF as it is', async () => {
    const hash = 'c3'.repeat(32);
    await bucket().put(AVATAR_KEY_PREFIX + hash, big(40_000), { httpMetadata: { contentType: 'image/gif' } });
    const { images, calls } = fakeImages(big(2_000));
    const { defer } = collect();

    const res = await serveAvatarThumb(bucket(), images, hash, defer);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(res.headers.get('content-length')).toBe('40000');
    expect(calls).toHaveLength(0);
  });

  it('keeps the source when the transform does not make it smaller', async () => {
    const hash = 'd4'.repeat(32);
    await bucket().put(AVATAR_KEY_PREFIX + hash, big(10_000), { httpMetadata: { contentType: 'image/jpeg' } });
    const { images } = fakeImages(big(12_000));
    const { defer, settle } = collect();

    const res = await serveAvatarThumb(bucket(), images, hash, defer);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-length')).toBe('10000');
    await settle();
    expect((await bucket().head(thumbAvatarKey(hash)))?.size).toBe(10000);
  });

  it('serves the full avatar and stores nothing when the transform fails or the binding is missing', async () => {
    const hash = 'e5'.repeat(32);
    await bucket().put(AVATAR_KEY_PREFIX + hash, big(20_000), { httpMetadata: { contentType: 'image/webp' } });
    const { images } = fakeImages('fail');
    const { defer, settle } = collect();

    const failed = await serveAvatarThumb(bucket(), images, hash, defer);
    expect(failed.status).toBe(200);
    expect(failed.headers.get('content-length')).toBe('20000');
    expect(failed.headers.get('cache-control')).toBe('public, max-age=300');
    const unbound = await serveAvatarThumb(bucket(), undefined, hash, defer);
    expect(unbound.headers.get('content-length')).toBe('20000');
    expect(unbound.headers.get('cache-control')).toBe('public, max-age=300');
    await settle();
    expect(await bucket().head(thumbAvatarKey(hash))).toBeNull();
  });

  it('404s on a miss, a malformed hash or a missing bucket', async () => {
    const { defer } = collect();
    expect((await serveAvatarThumb(bucket(), undefined, 'f6'.repeat(32), defer)).status).toBe(404);
    expect((await serveAvatarThumb(bucket(), undefined, 'not-a-hash', defer)).status).toBe(404);
    expect((await serveAvatarThumb(undefined, undefined, HASH, defer)).status).toBe(404);
  });
});

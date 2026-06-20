// Upload handler tests -- real workerd, real R2. Cover content-addressed
// storage with the sniffed content type, idempotency, and rejection of
// non-image bytes and oversized payloads.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleDrepImageUpload, sniffImageType } from './drepImageHandler.js';
import { AVATAR_KEY_PREFIX, type ImageDownscaler } from '../dreps/avatarStore.js';
import { bytesToHex } from '../crypto/hex.js';
import { toArrayBuffer } from '../crypto/bytes.js';

// Smallest valid-enough fixtures: magic bytes + padding. The handler validates
// magic bytes only (decoding a full image is not possible on Workers).
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_BYTES = new Uint8Array([...PNG_MAGIC, 1, 2, 3]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
// Stand-in for downscaler output; the real bytes come from the Images binding.
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9, 9]);

const ORIGIN = 'https://dreptalk.com';

function bucket(): R2Bucket {
  return (env as { AVATARS: R2Bucket }).AVATARS;
}

// Stand-in downscaler: returns the WebP fixture for any input.
const fakeDownscale: ImageDownscaler = async () => ({ bytes: toArrayBuffer(WEBP_BYTES), contentType: 'image/webp' });

describe('sniffImageType', () => {
  it('detects PNG and JPEG magic bytes and rejects the rest', () => {
    expect(sniffImageType(PNG_BYTES)).toBe('image/png');
    expect(sniffImageType(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});

describe('handleDrepImageUpload', () => {
  it('stores a PNG content-addressed and returns url + sha256', async () => {
    const res = await handleDrepImageUpload({ bytes: toArrayBuffer(PNG_BYTES), bucket: bucket(), origin: ORIGIN });

    expect(res.status).toBe(200);
    const { url, sha256 } = res.json as { url: string; sha256: string };
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(url).toBe(`${ORIGIN}/api/avatar/${sha256}`);

    const obj = await bucket().get(AVATAR_KEY_PREFIX + sha256);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe('image/png');
  });

  it('detects JPEG and stores image/jpeg', async () => {
    const res = await handleDrepImageUpload({ bytes: toArrayBuffer(JPEG_BYTES), bucket: bucket(), origin: ORIGIN });

    expect(res.status).toBe(200);
    const { sha256 } = res.json as { sha256: string };
    const obj = await bucket().get(AVATAR_KEY_PREFIX + sha256);
    expect(obj!.httpMetadata?.contentType).toBe('image/jpeg');
  });

  it('is idempotent for the same bytes', async () => {
    const a = await handleDrepImageUpload({ bytes: toArrayBuffer(PNG_BYTES), bucket: bucket(), origin: ORIGIN });
    const b = await handleDrepImageUpload({ bytes: toArrayBuffer(PNG_BYTES), bucket: bucket(), origin: ORIGIN });

    expect(b.status).toBe(200);
    expect((a.json as { sha256: string }).sha256).toBe((b.json as { sha256: string }).sha256);
  });

  it('rejects bytes that are neither PNG nor JPEG', async () => {
    const res = await handleDrepImageUpload({
      bytes: toArrayBuffer(new Uint8Array([1, 2, 3, 4, 5])),
      bucket: bucket(),
      origin: ORIGIN,
    });
    expect(res.status).toBe(415);
  });

  it('stores a sub-cap body as-is', async () => {
    // 300 KB: over the old 256 KB cap, under the new 512 KB cap.
    const mid = new Uint8Array(300 * 1024);
    mid.set(PNG_MAGIC);
    const res = await handleDrepImageUpload({ bytes: toArrayBuffer(mid), bucket: bucket(), origin: ORIGIN });
    expect(res.status).toBe(200);
    const { sha256 } = res.json as { sha256: string };
    expect((await bucket().get(AVATAR_KEY_PREFIX + sha256))!.httpMetadata?.contentType).toBe('image/png');
  });

  it('downscales an over-cap upload and returns the post-transform hash', async () => {
    const huge = new Uint8Array(600 * 1024); // over the 512 KB cap
    huge.set(PNG_MAGIC);
    const res = await handleDrepImageUpload({
      bytes: toArrayBuffer(huge),
      bucket: bucket(),
      origin: ORIGIN,
      downscale: fakeDownscale,
    });
    expect(res.status).toBe(200);
    const { sha256 } = res.json as { sha256: string };
    // The hash is of the stored (downscaled) bytes, not the upload, so the
    // on-chain hash the client embeds matches what /api/avatar serves.
    const webpHash = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(WEBP_BYTES))));
    expect(sha256).toBe(webpHash);
    expect((await bucket().get(AVATAR_KEY_PREFIX + sha256))!.httpMetadata?.contentType).toBe('image/webp');
  });

  it('rejects an over-cap upload when no downscaler is available', async () => {
    const huge = new Uint8Array(600 * 1024);
    huge.set(PNG_MAGIC);
    const res = await handleDrepImageUpload({ bytes: toArrayBuffer(huge), bucket: bucket(), origin: ORIGIN });
    expect(res.status).toBe(413);
  });

  it('rejects a payload over the hard ceiling', async () => {
    const over = new Uint8Array(10 * 1024 * 1024 + 1);
    over.set(PNG_MAGIC);
    const res = await handleDrepImageUpload({
      bytes: toArrayBuffer(over),
      bucket: bucket(),
      origin: ORIGIN,
      downscale: fakeDownscale,
    });
    expect(res.status).toBe(413);
  });
});

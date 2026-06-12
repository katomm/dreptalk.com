// Upload handler tests -- real workerd, real R2. Cover content-addressed
// storage with the sniffed content type, idempotency, and rejection of
// non-image bytes and oversized payloads.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleDrepImageUpload, sniffImageType } from './drepImageHandler.js';
import { AVATAR_KEY_PREFIX } from '../dreps/avatarStore.js';

// Smallest valid-enough fixtures: magic bytes + padding. The handler validates
// magic bytes only (decoding a full image is not possible on Workers).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const ORIGIN = 'https://dreptalk.com';

function bucket(): R2Bucket {
  return (env as { AVATARS: R2Bucket }).AVATARS;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

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

  it('rejects oversized payloads', async () => {
    const big = new Uint8Array(256 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await handleDrepImageUpload({ bytes: toArrayBuffer(big), bucket: bucket(), origin: ORIGIN });
    expect(res.status).toBe(413);
  });
});

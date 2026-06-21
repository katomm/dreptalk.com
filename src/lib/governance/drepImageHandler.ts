/// <reference types="@cloudflare/workers-types" />
// Upload handler for DRep profile images.
//
// Unauthenticated by design, like metadata hosting: the registration flow runs
// before any session exists, and authenticity is bound on-chain (the CIP-119
// document embeds this URL + sha256, and the wallet commits the doc hash as
// the anchor). Content-addressed writes cannot clobber; the route's per-IP
// rate limit bounds junk. Format is validated by magic bytes, never by the
// client-supplied content type.

import { bytesToHex } from '../crypto/hex.js';
import { AVATAR_KEY_PREFIX, MAX_DOWNLOAD_BYTES, fitAvatarForStore, type ImageDownscaler } from '../dreps/avatarStore.js';

export interface DrepImageUploadInput {
  bytes: ArrayBuffer;
  bucket: R2Bucket;
  origin: string;
  /** Downscaler for uploads over MAX_IMAGE_BYTES; when absent, oversized uploads are rejected. */
  downscale?: ImageDownscaler;
}

export interface DrepImageUploadResult {
  status: number;
  json: unknown;
}

/** PNG: 89 50 4E 47 0D 0A 1A 0A. JPEG: FF D8 FF. Returns the MIME type or null. */
export function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/** Never throws; unexpected errors become a generic 500. */
export async function handleDrepImageUpload(input: DrepImageUploadInput): Promise<DrepImageUploadResult> {
  try {
    return await handleInternal(input);
  } catch {
    return { status: 500, json: { error: 'internal error' } };
  }
}

async function handleInternal(input: DrepImageUploadInput): Promise<DrepImageUploadResult> {
  if (input.bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    return { status: 413, json: { error: 'image too large (max 10 MB)' } };
  }

  const sniffed = sniffImageType(new Uint8Array(input.bytes));
  if (!sniffed) {
    return { status: 415, json: { error: 'only JPG and PNG images are supported' } };
  }

  // Store small images as-is; downscale anything over the cap to a WebP
  // thumbnail. The returned sha256 is of the stored bytes, so the hash the
  // client embeds on-chain matches what /api/avatar later serves.
  const fitted = await fitAvatarForStore({ bytes: input.bytes, contentType: sniffed }, input.downscale);
  if (!fitted) {
    return { status: 413, json: { error: 'image too large (max 512 KB)' } };
  }

  const sha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', fitted.bytes)));
  const key = AVATAR_KEY_PREFIX + sha256;

  // Content-addressed: identical bytes already stored means nothing to do.
  const existing = await input.bucket.head(key);
  if (!existing) {
    await input.bucket.put(key, fitted.bytes, { httpMetadata: { contentType: fitted.contentType } });
  }

  return { status: 200, json: { url: `${input.origin}/api/avatar/${sha256}`, sha256 } };
}

/// <reference types="@cloudflare/workers-types" />
// Avatar store pass: downloads each DRep's CIP-119 image once and stores it in
// R2, content addressed by the sha256 of its bytes. Runs on the drep-sync cron.
// The download hardening that used to run per request in the serve proxy
// (https-only, timeout, type allowlist, size cap) runs here, once per image.
// Failures leave the row unchanged so the next run retries; one bad avatar
// never aborts the pass.
import { bytesToHex } from '../crypto/hex.js';
import {
  listDrepsNeedingAvatar,
  setDrepImageStored,
  clearOrphanedImageStore,
} from '../db/dreps.js';

// Maximum accepted image size (256 KB): larger is mislinked or hostile.
const MAX_IMAGE_BYTES = 256 * 1024;
// Upstream fetch timeout in milliseconds.
const FETCH_TIMEOUT_MS = 8_000;
// Raster types only. SVG is rejected: it can carry scripts.
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
// R2 key prefix; the full key is avatars/<sha256-hex>.
export const AVATAR_KEY_PREFIX = 'avatars/';

export interface AvatarStoreDeps {
  db: D1Database;
  bucket: R2Bucket;
  /** Image fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch;
  /** Max downloads per run; the backlog drains over successive cron runs. */
  limit?: number;
}

export interface AvatarStoreResult {
  /** Rows pulled from the work queue this run (orphan-cleared rows excluded). */
  scanned: number;
  stored: number;
  cleared: number;
  failed: number;
}

/** sha256 of the given bytes as lowercase hex. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/**
 * Downloads and validates one image. Returns null on any rejection: non-https,
 * fetch error/timeout, disallowed type, oversize, or empty body.
 */
async function fetchValidatedImage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      // Explicitly empty headers: never send cookies or auth to the image host.
      headers: {},
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(contentType)) return null;

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;

  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;

  return { bytes, contentType };
}

export async function storeDrepAvatars(deps: AvatarStoreDeps): Promise<AvatarStoreResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const limit = deps.limit ?? 25;

  // First null out rows whose on-chain image disappeared, so their objects
  // become unreferenced and the GC can reap them.
  const cleared = await clearOrphanedImageStore(deps.db);

  const rows = await listDrepsNeedingAvatar(deps.db, limit);
  let stored = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const img = await fetchValidatedImage(row.imageUrl, fetchImpl);
      if (!img) {
        failed++;
        continue;
      }
      const hash = await sha256Hex(img.bytes);
      // Idempotent: identical bytes across DReps share one object.
      await deps.bucket.put(AVATAR_KEY_PREFIX + hash, img.bytes, {
        httpMetadata: { contentType: img.contentType },
      });
      await setDrepImageStored(deps.db, row.drepId, hash, row.imageUrl);
      stored++;
    } catch {
      // Isolate per-DRep failures; the row stays unchanged and retries next run.
      failed++;
    }
  }

  return { scanned: rows.length, stored, cleared, failed };
}

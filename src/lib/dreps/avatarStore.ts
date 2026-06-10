/// <reference types="@cloudflare/workers-types" />
// Avatar store pass: downloads each DRep's CIP-119 image once and stores it in
// R2, content addressed by the sha256 of its bytes. Runs on the drep-sync cron.
// The download hardening that used to run per request in the serve proxy
// (https-only, timeout, type allowlist, size cap) runs here, once per image.
// Failures stamp image_fetch_failed_at so broken sources rotate to the back of
// the work queue instead of starving fresh rows; one bad avatar never aborts
// the pass.
import { bytesToHex } from '../crypto/hex.js';
import {
  listDrepsNeedingAvatar,
  setDrepImageStored,
  markDrepImageFetchFailed,
  clearOrphanedImageStore,
  listReferencedImageHashes,
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
  /** Failure stamp time (unix ms); defaults to Date.now(), injected for tests. */
  nowMs?: number;
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
  const nowMs = deps.nowMs ?? Date.now();

  // First null out rows whose on-chain image disappeared, so their objects
  // become unreferenced and the GC can reap them.
  const cleared = await clearOrphanedImageStore(deps.db);

  const rows = await listDrepsNeedingAvatar(deps.db, limit);
  let stored = 0;
  const failedIds: string[] = [];
  for (const row of rows) {
    try {
      const img = await fetchValidatedImage(row.imageUrl, fetchImpl);
      if (!img) {
        failedIds.push(row.drepId);
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
      // Isolate per-DRep failures; the stored columns stay unchanged.
      failedIds.push(row.drepId);
    }
  }

  // One batched stamp at the end of the pass: failed rows rotate behind fresh
  // work in the next run's queue instead of being re-selected first forever.
  await markDrepImageFetchFailed(deps.db, failedIds, nowMs);

  return { scanned: rows.length, stored, cleared, failed: failedIds.length };
}

// Grace period before an unreferenced object is deleted. Covers the window
// between an object landing in R2 and its DB row being visible to the GC's
// referenced-set read (mirrors the drep-metadata GC).
const AVATAR_GC_GRACE_MS = 24 * 60 * 60 * 1000;

export interface AvatarGcDeps {
  db: D1Database;
  bucket: R2Bucket;
  nowMs: number;
  /** Max deletions per run; the backlog drains over successive cron runs. */
  deleteLimit?: number;
}

/**
 * Deletes avatars/<hash> objects that no dreps row references anymore, once
 * they are older than the grace period. Paginates the R2 listing; bounded
 * deletions per run.
 */
export async function gcDrepAvatars(deps: AvatarGcDeps): Promise<{ scanned: number; deleted: number }> {
  const deleteLimit = deps.deleteLimit ?? 200;
  const referenced = await listReferencedImageHashes(deps.db);

  // Collect deletable keys first (each page is scanned fully so `scanned` is
  // accurate), then delete in batches: R2 accepts up to 1000 keys per call, so
  // a full run costs one or two delete round-trips instead of one per object.
  let scanned = 0;
  const toDelete: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.bucket.list({ prefix: AVATAR_KEY_PREFIX, cursor });
    for (const obj of page.objects) {
      scanned++;
      if (toDelete.length >= deleteLimit) continue;
      const hash = obj.key.slice(AVATAR_KEY_PREFIX.length);
      if (referenced.has(hash)) continue;
      if (deps.nowMs - obj.uploaded.getTime() < AVATAR_GC_GRACE_MS) continue;
      toDelete.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && toDelete.length < deleteLimit);

  for (let i = 0; i < toDelete.length; i += 1000) {
    await deps.bucket.delete(toDelete.slice(i, i + 1000));
  }

  return { scanned, deleted: toDelete.length };
}

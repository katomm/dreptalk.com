/// <reference types="@cloudflare/workers-types" />
// Avatar store pass: downloads each DRep's CIP-119 image once and stores it in
// R2, content addressed by the sha256 of its bytes. Runs on the drep-sync cron.
// The download hardening that used to run per request in the serve proxy
// (https-only, timeout, type allowlist, size cap) runs here, once per image.
// Failures stamp image_fetch_failed_at so broken sources rotate to the back of
// the work queue instead of starving fresh rows; one bad avatar never aborts
// the pass.
import { bytesToHex } from '../crypto/hex.js';
import { readBodyLimited } from '../http/bodyLimit.js';
import { selfHostedRef } from '../governance/selfHostedDocs.js';
import {
  listDrepsNeedingAvatar,
  setDrepImageStored,
  markDrepImageFetchFailed,
  clearOrphanedImageStore,
  listReferencedImageHashes,
  repointDrepImageHash,
} from '../db/dreps.js';
import { repointPoolImageHash, listReferencedPoolImageHashes } from '../db/pools.js';

// Hard ceiling on the bytes we are willing to keep in R2 for one avatar (512 KB).
// An image over this is only storable as a downscaled WebP; without a downscaler
// it is rejected. Exported so the upload endpoint shares the same cap.
export const MAX_IMAGE_BYTES = 512 * 1024;
// Above this size (24 KB) an avatar is refitted to AVATAR_MAX_EDGE as WebP before
// storing. Sources are routinely 512px or 1024px artwork shown in a 38px list
// cell, so the source bytes are mostly resolution nobody ever sees: a typical
// 200 KB PNG lands around 12 KB with no visible difference at any size the UI
// renders. Below the threshold the source is already cheap enough that a
// re-encode is not worth the transform, so it is stored byte for byte.
export const AVATAR_REFIT_ABOVE_BYTES = 24 * 1024;
// Hard ceiling on a fetched or uploaded image (10 MB). Above this the source is
// treated as mislinked or hostile and rejected outright, even for downscaling.
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
// Longest edge (px) a downscaled avatar is fitted to. The largest on-screen
// avatar is 96px (the profile hero), so 256px covers it at 2x DPI with margin.
const AVATAR_MAX_EDGE = 256;
// WebP quality for downscaled avatars. High enough to stay near the original at
// avatar sizes; the output is still tiny (well under MAX_IMAGE_BYTES).
const AVATAR_DOWNSCALE_QUALITY = 90;
// Upstream fetch timeout in milliseconds.
const FETCH_TIMEOUT_MS = 8_000;
// Raster types only. SVG is rejected: it can carry scripts.
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
// R2 key prefix; the full key is avatars/<sha256-hex>.
export const AVATAR_KEY_PREFIX = 'avatars/';
// R2 key prefix for the PNG rendition of an avatar the card rasterizer cannot
// decode (webp/avif/gif). Derived from the stored bytes on first use and keyed by
// the same content hash, so it stays valid as long as the avatar does. Kept off
// the avatars/ prefix so the store pass and the serve proxy never see it.
export const OG_AVATAR_KEY_PREFIX = 'og-avatars/';

/** R2 key of the PNG rendition for a stored avatar hash. */
export function ogAvatarKey(hash: string): string {
  return `${OG_AVATAR_KEY_PREFIX}${hash}.png`;
}

/** A downscaler: returns smaller bytes for an oversized image, or null if it cannot. */
export type ImageDownscaler = (bytes: ArrayBuffer) => Promise<{ bytes: ArrayBuffer; contentType: string } | null>;

/** Minimal structural view of the Cloudflare Images binding (env.IMAGES). */
export interface ImagesLike {
  input(stream: ReadableStream): ImagesTransformer;
}
interface ImagesTransformer {
  transform(opts: { width?: number; height?: number; fit?: string }): ImagesTransformer;
  output(opts: { format: string; quality?: number }): Promise<{ response(): Response }>;
}

/**
 * Wraps the Cloudflare Images binding into a downscaler that fits an avatar to
 * AVATAR_MAX_EDGE and re-encodes it as WebP. Never upscales (fit: scale-down).
 * Returns null on any transform error, or if the result is still over the cap,
 * so the caller treats it as a failed image.
 */
export function imagesDownscaler(images: ImagesLike): ImageDownscaler {
  return async (bytes) => {
    try {
      const result = await images
        .input(new Response(bytes).body as ReadableStream)
        .transform({ width: AVATAR_MAX_EDGE, height: AVATAR_MAX_EDGE, fit: 'scale-down' })
        .output({ format: 'image/webp', quality: AVATAR_DOWNSCALE_QUALITY });
      const out = await result.response().arrayBuffer();
      if (out.byteLength === 0 || out.byteLength > MAX_IMAGE_BYTES) return null;
      return { bytes: out, contentType: 'image/webp' };
    } catch {
      return null;
    }
  };
}

/**
 * Wraps the Cloudflare Images binding into a re-encoder that fits an avatar to
 * AVATAR_MAX_EDGE and outputs PNG, for formats the card rasterizer cannot decode.
 * Returns null on any transform error, on empty output, or if the result is over
 * MAX_IMAGE_BYTES, so the caller falls back to the identicon.
 */
export function pngRenditionEncoder(images: ImagesLike): ImageDownscaler {
  return async (bytes) => {
    try {
      const result = await images
        .input(new Response(bytes).body as ReadableStream)
        .transform({ width: AVATAR_MAX_EDGE, height: AVATAR_MAX_EDGE, fit: 'scale-down' })
        .output({ format: 'image/png' });
      const out = await result.response().arrayBuffer();
      if (out.byteLength === 0 || out.byteLength > MAX_IMAGE_BYTES) return null;
      return { bytes: out, contentType: 'image/png' };
    } catch {
      return null;
    }
  };
}

/**
 * Decides what bytes to store for an avatar: the source when it is already small
 * or cannot be improved, otherwise the refitted WebP. Returns null only when the
 * image is over MAX_IMAGE_BYTES and refitting is unavailable or failed, so each
 * caller maps that to its own failure (a failed sync row, or a 413 on upload).
 */
export async function fitAvatarForStore(
  img: { bytes: ArrayBuffer; contentType: string },
  downscale?: ImageDownscaler,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  // Whether the source is storable at all, i.e. whether falling back to it is an
  // option once refitting is ruled out.
  const sourceStorable = img.bytes.byteLength <= MAX_IMAGE_BYTES;
  if (img.bytes.byteLength <= AVATAR_REFIT_ABOVE_BYTES) return img;
  // A GIF may be animated, and the WebP transform keeps only the first frame.
  // So a GIF is refitted only when the alternative is rejecting it outright,
  // never merely to save bytes on one that is already storable as it stands.
  if (img.contentType === 'image/gif' && sourceStorable) return img;

  const refitted = await downscale?.(img.bytes);
  // The transform can lose to a well packed source (a small flat-colour PNG, an
  // image already at avatar size). Keep whichever is actually smaller.
  if (!refitted || (sourceStorable && refitted.bytes.byteLength >= img.bytes.byteLength)) {
    return sourceStorable ? img : null;
  }
  return refitted;
}

// How many times the avatar pass may fail to fetch or validate a DRep's image
// before it gives up and stops re-attempting that DRep. At the 6-hour dreps
// cadence this is over two days of continuous failure, so only a permanently
// broken source is abandoned. Giving up keeps the dreps sync from being pinned
// at 'partial' forever. A successful store resets the counter.
export const AVATAR_FETCH_MAX_ATTEMPTS = 10;

export interface AvatarStoreDeps {
  db: D1Database;
  bucket: R2Bucket;
  /** Image fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch;
  /** Refitter for images over AVATAR_REFIT_ABOVE_BYTES; when absent, over-cap images fail. */
  downscale?: ImageDownscaler;
  /** Max downloads per run; the backlog drains over successive cron runs. */
  limit?: number;
  /** Give-up cap for failed fetches per DRep; defaults to AVATAR_FETCH_MAX_ATTEMPTS. */
  maxAttempts?: number;
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
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/**
 * Downloads and validates one image. Returns null on any rejection: non-https,
 * fetch error/timeout, disallowed type, oversize, or empty body.
 */
export async function fetchValidatedImage(
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
  // A self-zone URL can never be fetched from a Worker: the same-zone
  // subrequest blackholes at the placeholder origin. Fail fast for every
  // caller (DRep avatars, pool logos) instead of hanging out the timeout.
  if (selfHostedRef(url)) return null;

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
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return null;

  // Content-Length is only a fast path; the bounded reader enforces the cap
  // even for chunked or lying senders without buffering past the limit. The
  // catch covers mid-body stream errors, matching the old arrayBuffer() shape.
  const read = await readBodyLimited(res.body, MAX_DOWNLOAD_BYTES).catch(() => null);
  if (!read?.ok || read.bytes.byteLength === 0) return null;

  return { bytes: read.bytes.buffer as ArrayBuffer, contentType };
}

/**
 * Decodes a base64 `data:` image URI into raster bytes, or null. Rejects
 * non-data URIs, non-base64 payloads, empty payloads, and any media type
 * outside ALLOWED_TYPES (so SVG stays out, exactly as for fetched images). The
 * declared media type is trusted to the same degree as a fetched image's
 * Content-Type, since both are equally source controlled.
 */
export function decodeDataUriImage(uri: string): { bytes: ArrayBuffer; contentType: string } | null {
  if (!uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  // The part between "data:" and "," is "<mediatype>[;param][;base64]".
  const params = uri.slice(5, comma).split(';').map((p) => p.trim().toLowerCase());
  const contentType = params[0];
  if (!ALLOWED_TYPES.includes(contentType)) return null;
  if (!params.includes('base64')) return null;

  let binary: string;
  try {
    // Tolerate stray whitespace/newlines some encoders insert into the payload.
    binary = atob(uri.slice(comma + 1).replace(/\s/g, ''));
  } catch {
    return null;
  }
  if (binary.length === 0 || binary.length > MAX_DOWNLOAD_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes: bytes.buffer, contentType };
}

/**
 * Stores an inline base64 `data:` avatar (carried in the CIP-119 doc itself) to
 * R2, content addressed by the sha256 of its bytes, and returns the hash. Reuses
 * the same validation, downscaling, and key layout as the fetched-URL path; no
 * network request is made because the bytes are already in the document. Returns
 * null when the URI is not a storable image (so the caller keeps the identicon).
 */
export async function ingestDataUriAvatar(
  bucket: R2Bucket,
  dataUri: string,
  downscale?: ImageDownscaler,
): Promise<string | null> {
  const decoded = decodeDataUriImage(dataUri);
  if (!decoded) return null;
  const toStore = await fitAvatarForStore(decoded, downscale);
  if (!toStore) return null;
  const hash = await sha256Hex(toStore.bytes);
  await bucket.put(AVATAR_KEY_PREFIX + hash, toStore.bytes, {
    httpMetadata: { contentType: toStore.contentType },
  });
  return hash;
}

export async function storeDrepAvatars(deps: AvatarStoreDeps): Promise<AvatarStoreResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const limit = deps.limit ?? 25;
  const maxAttempts = deps.maxAttempts ?? AVATAR_FETCH_MAX_ATTEMPTS;
  const nowMs = deps.nowMs ?? Date.now();

  // First null out rows whose on-chain image disappeared, so their objects
  // become unreferenced and the GC can reap them.
  const cleared = await clearOrphanedImageStore(deps.db);

  const rows = await listDrepsNeedingAvatar(deps.db, limit, maxAttempts);
  let stored = 0;
  const failedIds: string[] = [];
  for (const row of rows) {
    try {
      // A self-zone image URL can never be fetched from a Worker (the same-zone
      // subrequest blackholes at the placeholder origin). An /api/avatar/<hash>
      // URL, minted by our own upload flow, means the bytes are ALREADY in this
      // bucket: adopt the hash directly. Any other self-zone URL fails
      // immediately instead of hanging through a doomed fetch.
      const ref = selfHostedRef(row.imageUrl);
      if (ref) {
        if (ref.kind === 'avatar' && (await deps.bucket.head(AVATAR_KEY_PREFIX + ref.hash))) {
          await setDrepImageStored(deps.db, row.drepId, ref.hash, row.imageUrl);
          stored++;
        } else {
          failedIds.push(row.drepId);
        }
        continue;
      }
      const img = await fetchValidatedImage(row.imageUrl, fetchImpl);
      if (!img) {
        failedIds.push(row.drepId);
        continue;
      }
      // Store small images byte-for-byte; refit anything larger to a WebP
      // thumbnail. No downscaler -> only over-cap images fail.
      const toStore = await fitAvatarForStore(img, deps.downscale);
      if (!toStore) {
        failedIds.push(row.drepId);
        continue;
      }
      const hash = await sha256Hex(toStore.bytes);
      // Idempotent: identical bytes across DReps share one object.
      await deps.bucket.put(AVATAR_KEY_PREFIX + hash, toStore.bytes, {
        httpMetadata: { contentType: toStore.contentType },
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

// Marker written into an object's R2 custom metadata once the refit pass has
// considered it, so a later run skips it without paying for another read and
// transform. The value records the outcome ('refit' for a rewritten object,
// 'source' for one kept as it was) purely for debugging; only its presence is
// checked. Objects written before the pass existed carry no marker, which is
// what makes them visible to it in the first place.
const AVATAR_FIT_MARKER = 'avatarFit';

export interface AvatarRefitDeps {
  db: D1Database;
  bucket: R2Bucket;
  /** Refitter; without it the pass is a no-op, since refitting is the whole job. */
  downscale?: ImageDownscaler;
  /** Max objects read and transformed per run; the backlog drains over runs. */
  limit?: number;
}

export interface AvatarRefitResult {
  /** Objects considered this run (over the threshold and not yet marked). */
  scanned: number;
  /** Objects rewritten smaller, with their referencing rows moved over. */
  refitted: number;
  /** Objects kept as they were, marked so they are not revisited. */
  kept: number;
  /** Bytes saved across the rewritten objects. */
  savedBytes: number;
}

/**
 * One-way pass over avatars already in R2, rewriting anything stored at full
 * source resolution to display size. Existing objects predate the refit rule in
 * fitAvatarForStore, so without this they would keep their original bytes
 * forever: nothing re-fetches an avatar whose source URL has not changed.
 *
 * The bytes are refitted from the stored object itself, so no upstream request
 * is made and a source that has since gone offline is refitted just the same.
 * Refitting changes the content hash, so the referencing dreps and pools rows
 * are moved to the new hash and the old object falls to the avatar GC. Only
 * referenced objects are considered, and each one is marked whichever way it
 * goes, so the pass settles to zero work once the bucket is caught up.
 */
export async function refitStoredAvatars(deps: AvatarRefitDeps): Promise<AvatarRefitResult> {
  const result: AvatarRefitResult = { scanned: 0, refitted: 0, kept: 0, savedBytes: 0 };
  if (!deps.downscale) return result;
  const limit = deps.limit ?? 50;

  // Only objects something still points at are worth refitting. This also keeps
  // the pass off the object it just replaced: that one is unreferenced from the
  // moment its rows move, so the next run walks past it and the GC reaps it.
  const referenced = await listReferencedImageHashes(deps.db);
  for (const h of await listReferencedPoolImageHashes(deps.db)) referenced.add(h);

  let cursor: string | undefined;
  do {
    const page = await deps.bucket.list({
      prefix: AVATAR_KEY_PREFIX,
      cursor,
      include: ['customMetadata', 'httpMetadata'],
    });
    for (const listed of page.objects) {
      if (result.scanned >= limit) return result;
      if (listed.size <= AVATAR_REFIT_ABOVE_BYTES) continue;
      if (listed.customMetadata?.[AVATAR_FIT_MARKER]) continue;
      const oldHash = listed.key.slice(AVATAR_KEY_PREFIX.length);
      if (!referenced.has(oldHash)) continue;
      result.scanned++;

      const contentType = listed.httpMetadata?.contentType ?? 'image/png';
      try {
        const obj = await deps.bucket.get(listed.key);
        if (!obj) continue;
        const bytes = await obj.arrayBuffer();
        // Same decision as on the way in, so a stored object ends up with the
        // bytes it would have had if it had arrived after the refit rule.
        const fitted = await fitAvatarForStore({ bytes, contentType }, deps.downscale);
        const newHash = fitted ? await sha256Hex(fitted.bytes) : oldHash;
        if (!fitted || newHash === oldHash) {
          // Unchanged: keep the object and mark it so it is skipped from now on.
          await deps.bucket.put(listed.key, bytes, {
            httpMetadata: { contentType },
            customMetadata: { ...listed.customMetadata, [AVATAR_FIT_MARKER]: 'source' },
          });
          result.kept++;
          continue;
        }

        // Write the smaller object before moving any row to it, so no row can
        // ever point at a key that is not there yet.
        await deps.bucket.put(AVATAR_KEY_PREFIX + newHash, fitted.bytes, {
          httpMetadata: { contentType: fitted.contentType },
          customMetadata: { [AVATAR_FIT_MARKER]: 'refit' },
        });
        await repointDrepImageHash(deps.db, oldHash, newHash);
        await repointPoolImageHash(deps.db, oldHash, newHash);
        result.refitted++;
        result.savedBytes += bytes.byteLength - fitted.bytes.byteLength;
      } catch {
        // Isolate per-object failures; an unmarked object is simply retried on
        // the next run, and the rows keep pointing at bytes that still exist.
        continue;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return result;
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
  /** Additional referenced hashes (e.g. pool logos) that share the avatars/ prefix. */
  extraReferenced?: Set<string>;
}

/**
 * Deletes avatars/<hash> and og-avatars/<hash>.png objects that no dreps row
 * references anymore, once they are older than the grace period. Both prefixes
 * are keyed by the same content hash, so an avatar and its PNG rendition go at
 * the same time. Paginates the R2 listing; bounded deletions per run.
 */
export async function gcDrepAvatars(deps: AvatarGcDeps): Promise<{ scanned: number; deleted: number }> {
  const deleteLimit = deps.deleteLimit ?? 200;
  const referenced = await listReferencedImageHashes(deps.db);
  if (deps.extraReferenced) for (const h of deps.extraReferenced) referenced.add(h);

  // Collect deletable keys first (each page is scanned fully so `scanned` is
  // accurate), then delete in batches: R2 accepts up to 1000 keys per call, so
  // a full run costs one or two delete round-trips instead of one per object.
  let scanned = 0;
  const toDelete: string[] = [];

  const sweep = async (prefix: string, hashOf: (key: string) => string) => {
    let cursor: string | undefined;
    do {
      const page = await deps.bucket.list({ prefix, cursor });
      for (const obj of page.objects) {
        scanned++;
        if (toDelete.length >= deleteLimit) continue;
        if (referenced.has(hashOf(obj.key))) continue;
        if (deps.nowMs - obj.uploaded.getTime() < AVATAR_GC_GRACE_MS) continue;
        toDelete.push(obj.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && toDelete.length < deleteLimit);
  };

  await sweep(AVATAR_KEY_PREFIX, (key) => key.slice(AVATAR_KEY_PREFIX.length));
  await sweep(OG_AVATAR_KEY_PREFIX, (key) =>
    key.slice(OG_AVATAR_KEY_PREFIX.length).replace(/\.png$/, ''),
  );

  for (let i = 0; i < toDelete.length; i += 1000) {
    await deps.bucket.delete(toDelete.slice(i, i + 1000));
  }

  return { scanned, deleted: toDelete.length };
}

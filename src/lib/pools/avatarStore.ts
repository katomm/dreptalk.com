/// <reference types="@cloudflare/workers-types" />
// Pool logo store pass: downloads each pool's resolved logo once and stores it in
// R2 content-addressed under the shared avatars/ prefix, reusing the drep avatar
// download hardening, downscaling, and key layout. Failures stamp the row so a
// broken source rotates to the back of the queue. Mirrors storeDrepAvatars.
import {
  fetchValidatedImage,
  sha256Hex,
  fitAvatarForStore,
  AVATAR_KEY_PREFIX,
  AVATAR_FETCH_MAX_ATTEMPTS,
  type ImageDownscaler,
} from '../dreps/avatarStore.js';
import {
  listPoolsNeedingAvatar,
  setPoolImageStored,
  markPoolImageFetchFailed,
  clearOrphanedPoolImageStore,
} from '../db/pools.js';

export interface PoolAvatarStoreDeps {
  db: D1Database;
  bucket: R2Bucket;
  fetchImpl?: typeof fetch;
  downscale?: ImageDownscaler;
  limit?: number;
  maxAttempts?: number;
  nowMs?: number;
}

export async function storePoolAvatars(deps: PoolAvatarStoreDeps): Promise<{
  scanned: number;
  stored: number;
  cleared: number;
  failed: number;
}> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const limit = deps.limit ?? 25;
  const maxAttempts = deps.maxAttempts ?? AVATAR_FETCH_MAX_ATTEMPTS;
  const nowMs = deps.nowMs ?? Date.now();

  const cleared = await clearOrphanedPoolImageStore(deps.db);
  const rows = await listPoolsNeedingAvatar(deps.db, limit, maxAttempts);
  let stored = 0;
  const failedIds: string[] = [];
  for (const row of rows) {
    try {
      const img = await fetchValidatedImage(row.imageUrl, fetchImpl);
      if (!img) {
        failedIds.push(row.poolId);
        continue;
      }
      const toStore = await fitAvatarForStore(img, deps.downscale);
      if (!toStore) {
        failedIds.push(row.poolId);
        continue;
      }
      const hash = await sha256Hex(toStore.bytes);
      await deps.bucket.put(AVATAR_KEY_PREFIX + hash, toStore.bytes, {
        httpMetadata: { contentType: toStore.contentType },
      });
      await setPoolImageStored(deps.db, row.poolId, hash, row.imageUrl);
      stored++;
    } catch {
      failedIds.push(row.poolId);
    }
  }
  await markPoolImageFetchFailed(deps.db, failedIds, nowMs);
  return { scanned: rows.length, stored, cleared, failed: failedIds.length };
}

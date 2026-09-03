/// <reference types="@cloudflare/workers-types" />
// One-way backfill: avatars stored before the display-size rule kept their
// source bytes, so a 1024px artwork behind a 38px list cell was served at full
// resolution. This pass refits those objects and moves the rows referencing
// them onto the smaller copy.
//
// The bytes are refitted from the stored object itself, so no upstream request
// is made and a source that has since gone offline is refitted just the same.
//
// Neutral ground on purpose: DReps and pool logos share one bucket and one
// object can back rows in both tables, so each table contributes its own queue
// and writers through RefitTable rather than this module reaching into either.
import {
  fitAvatarForStore,
  sha256Hex,
  AVATAR_KEY_PREFIX,
  AVATAR_REFIT_ABOVE_BYTES,
  refitDropsAnimation,
  MAX_IMAGE_BYTES,
  type ImageDownscaler,
} from '../dreps/avatarStore.js';

/** One table's side of the refit: its work queue and the two writes it needs. */
export interface RefitTable {
  /** Distinct stored hashes not yet measured against the size rule. */
  listPending(db: D1Database, limit: number): Promise<string[]>;
  /** Stamps every row on these objects as measured, whatever the outcome. */
  markChecked(db: D1Database, hashes: string[]): Promise<void>;
  /** Moves every row on oldHash to newHash. */
  repoint(db: D1Database, oldHash: string, newHash: string): Promise<number>;
}

export interface AvatarRefitDeps {
  db: D1Database;
  bucket: R2Bucket;
  /** The tables whose rows reference objects in the bucket. */
  tables: RefitTable[];
  /** Refitter; without it the pass is a no-op, since refitting is the whole job. */
  downscale?: ImageDownscaler;
  /**
   * Max objects considered per run; the backlog drains over successive runs.
   * Most cost nothing but a head() (already small enough, or a GIF), and only
   * the rest pay a read, a transform and a write, so this sits well inside what
   * the DRep cron has left after its anchor budget.
   */
  limit?: number;
}

export interface AvatarRefitResult {
  /** Objects considered this run. Zero once the backfill has drained. */
  scanned: number;
  /** Objects rewritten smaller, with their referencing rows moved over. */
  refitted: number;
  /** Bytes saved across the rewritten objects. */
  savedBytes: number;
}

/**
 * Refits one bounded batch of not-yet-measured avatars. Every object it looks at
 * is stamped, whichever way it goes, so the queue shrinks monotonically and the
 * pass costs one empty query per run once it has drained.
 *
 * Refitting changes the content hash, so the referencing rows are moved to the
 * new hash and the old object is left to the avatar GC, which reaps it after its
 * grace period once nothing points at it.
 */
export async function refitStoredAvatars(deps: AvatarRefitDeps): Promise<AvatarRefitResult> {
  const result: AvatarRefitResult = { scanned: 0, refitted: 0, savedBytes: 0 };
  if (!deps.downscale) return result;
  const limit = deps.limit ?? 25;

  const queues = await Promise.all(deps.tables.map((t) => t.listPending(deps.db, limit)));
  // One object can back rows in several tables; consider it once.
  const hashes = [...new Set(queues.flat())].slice(0, limit);
  if (hashes.length === 0) return result;

  const checked: string[] = [];
  for (const oldHash of hashes) {
    result.scanned++;
    try {
      // head() carries size and content type, which is all the cheap decisions
      // need. Only an object that survives them is worth reading in full.
      const meta = await deps.bucket.head(AVATAR_KEY_PREFIX + oldHash);
      const contentType = meta?.httpMetadata?.contentType ?? 'image/png';
      const storableAsIs = !!meta && meta.size <= MAX_IMAGE_BYTES;
      if (
        !meta ||
        meta.size <= AVATAR_REFIT_ABOVE_BYTES ||
        (refitDropsAnimation(contentType) && storableAsIs)
      ) {
        // Already small enough, gone, or deliberately left alone: nothing to do,
        // and nothing to read. A dangling hash is stamped too, so it stops
        // coming back; the row's own sync owns repairing it.
        checked.push(oldHash);
        continue;
      }

      const obj = await deps.bucket.get(AVATAR_KEY_PREFIX + oldHash);
      if (!obj) {
        checked.push(oldHash);
        continue;
      }
      const bytes = await obj.arrayBuffer();
      // Same decision as on the way in, so a stored object ends up with the
      // bytes it would have had if it had arrived after the size rule.
      const source = { bytes, contentType };
      const fitted = await fitAvatarForStore(source, deps.downscale);
      // fitAvatarForStore hands back the very object it was given when it keeps
      // the source, so identity answers "did anything change" without hashing
      // the full body a second time.
      if (!fitted || fitted === source) {
        checked.push(oldHash);
        continue;
      }

      // Write the smaller object before moving any row to it, so no row can ever
      // point at a key that is not there yet.
      const newHash = await sha256Hex(fitted.bytes);
      await deps.bucket.put(AVATAR_KEY_PREFIX + newHash, fitted.bytes, {
        httpMetadata: { contentType: fitted.contentType },
      });
      await Promise.all(deps.tables.map((t) => t.repoint(deps.db, oldHash, newHash)));
      // Stamp the hash the rows now carry: the old one no longer matches any row.
      checked.push(newHash);
      result.refitted++;
      result.savedBytes += bytes.byteLength - fitted.bytes.byteLength;
    } catch {
      // Isolate per-object failures. An unstamped object simply comes back on
      // the next run, and its rows keep pointing at bytes that still exist.
      continue;
    }
  }

  await Promise.all(deps.tables.map((t) => t.markChecked(deps.db, checked)));
  return result;
}

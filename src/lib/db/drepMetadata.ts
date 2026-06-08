/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the drep_metadata table.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
// Tracks the exact JSON bytes and their blake2b-256 hash that we serve for a DRep.
// The chain is the source of truth for registration state; this table is hosting-only.
//
// Content-addressed: the table is keyed by (drep_id, hash). A write can never
// overwrite a different document under the same drep id (different content ->
// different hash -> different row), so the unauthenticated hosting endpoint
// cannot be used to clobber a legitimate DRep's served bytes.

export interface DrepMetadata {
  drepId: string;
  body: string;
  hash: string;
  name: string;
  createdAt: number;
}

// Raw row shape as stored in D1.
interface DrepMetadataRow {
  drep_id: string;
  body: string;
  hash: string;
  name: string;
  created_at: number;
}

/** Maps a raw D1 row to the DrepMetadata type. */
function rowToDrepMetadata(row: DrepMetadataRow): DrepMetadata {
  return {
    drepId: row.drep_id,
    body: row.body,
    hash: row.hash,
    name: row.name,
    createdAt: row.created_at,
  };
}

/**
 * Inserts the content-addressed metadata row for a DRep.
 * Uses INSERT OR IGNORE keyed by (drep_id, hash): re-posting identical content
 * is an idempotent no-op, and a different document is a new row that never
 * overwrites the existing one. All values are bound; no string-interpolated SQL.
 */
export async function putDrepMetadata(
  db: D1Database,
  args: {
    drepId: string;
    body: string;
    hash: string;
    name: string;
    createdAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO drep_metadata (drep_id, body, hash, name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(args.drepId, args.body, args.hash, args.name, args.createdAt)
    .run();
}

/**
 * Returns the content-addressed metadata row for (drepId, hash), or null.
 * This is the authoritative read for serving the document at its anchor URL:
 * the bytes returned hash to `hash`, which is what the on-chain anchor commits to.
 * Parameterized SELECT; no string-interpolated SQL.
 */
export async function getDrepMetadataByHash(
  db: D1Database,
  drepId: string,
  hash: string,
): Promise<DrepMetadata | null> {
  const row = await db
    .prepare('SELECT * FROM drep_metadata WHERE drep_id = ? AND hash = ?')
    .bind(drepId, hash)
    .first<DrepMetadataRow>();
  return row ? rowToDrepMetadata(row) : null;
}


/**
 * Garbage-collects hosted DRep metadata that is no longer wanted: rows older
 * than the cutoff whose drep id is not currently registered AND whose hash is
 * not a current on-chain anchor. This removes junk written for self-generated
 * keys without ever deleting a real DRep's metadata (a real DRep is either a
 * registered id or has its hash referenced on-chain). Scans at most `limit`
 * old rows per call; repeated runs converge.
 *
 * Returns how many old rows were scanned and how many were deleted.
 */
export async function gcDrepMetadata(
  db: D1Database,
  args: {
    registeredIds: Set<string>;
    keepHashes: Set<string>;
    olderThanSec: number;
    limit?: number;
  },
): Promise<{ scanned: number; deleted: number }> {
  const limit = args.limit ?? 2000;

  const rows =
    (
      await db
        .prepare('SELECT drep_id, hash FROM drep_metadata WHERE created_at < ? LIMIT ?')
        .bind(args.olderThanSec, limit)
        .all<{ drep_id: string; hash: string }>()
    ).results ?? [];

  const toDelete = rows.filter(
    (r) => !args.registeredIds.has(r.drep_id) && !args.keepHashes.has(r.hash.toLowerCase()),
  );

  // Delete by the exact (drep_id, hash) pair: under content-addressing a single
  // drep id may have both a kept (referenced) row and a junk row, so deleting by
  // drep_id alone would wrongly remove the referenced one. One batch, not N round trips.
  if (toDelete.length > 0) {
    await db.batch(
      toDelete.map((r) =>
        db.prepare('DELETE FROM drep_metadata WHERE drep_id = ? AND hash = ?').bind(r.drep_id, r.hash),
      ),
    );
  }

  return { scanned: rows.length, deleted: toDelete.length };
}

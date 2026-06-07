/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the drep_metadata table.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
// Tracks the exact JSON bytes and their blake2b-256 hash that we serve for a DRep.
// The chain is the source of truth for registration state; this table is hosting-only.

import { sqlPlaceholders } from './sql.js';

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
 * Inserts or replaces the metadata row for a DRep.
 * Uses INSERT OR REPLACE so re-registration updates all fields atomically.
 * All values are bound via parameterized statement; no string-interpolated SQL.
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
      `INSERT OR REPLACE INTO drep_metadata (drep_id, body, hash, name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(args.drepId, args.body, args.hash, args.name, args.createdAt)
    .run();
}

/**
 * Returns the metadata row for the given DRep id, or null if not found.
 * Parameterized SELECT; no string-interpolated SQL.
 */
export async function getDrepMetadata(
  db: D1Database,
  drepId: string,
): Promise<DrepMetadata | null> {
  const row = await db
    .prepare('SELECT * FROM drep_metadata WHERE drep_id = ?')
    .bind(drepId)
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

  const toDelete = rows
    .filter((r) => !args.registeredIds.has(r.drep_id) && !args.keepHashes.has(r.hash.toLowerCase()))
    .map((r) => r.drep_id);

  // Delete in bounded batches to respect the SQLite bound-parameter limit.
  for (let i = 0; i < toDelete.length; i += 50) {
    const batch = toDelete.slice(i, i + 50);
    await db
      .prepare(`DELETE FROM drep_metadata WHERE drep_id IN (${sqlPlaceholders(batch)})`)
      .bind(...batch)
      .run();
  }

  return { scanned: rows.length, deleted: toDelete.length };
}

/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the drep_metadata table.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
// Tracks the exact JSON bytes and their blake2b-256 hash that we serve for a DRep.
// The chain is the source of truth for registration state; this table is hosting-only.

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

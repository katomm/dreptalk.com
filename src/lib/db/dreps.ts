/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the dreps table.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
// Stores on-chain DRep status and CIP-119 profile data synced from Koios.

export interface Drep {
  drepId: string;
  hex: string | null;
  hasScript: boolean;
  status: string;
  active: boolean;
  deposit: string | null;
  votingPower: string | null;
  expiresEpochNo: number | null;
  name: string | null;
  bio: string | null;
  imageUrl: string | null;
  links: { label: string; uri: string }[] | null;
  anchorUrl: string | null;
  anchorHash: string | null;
  anchorStatus: string;
  lastSyncedAt: number;
  createdAt: number;
}

// Raw row shape as stored in D1 (booleans as 0/1 integers, links as JSON string).
interface DrepRow {
  drep_id: string;
  hex: string | null;
  has_script: number;
  status: string;
  active: number;
  deposit: string | null;
  voting_power: string | null;
  expires_epoch_no: number | null;
  name: string | null;
  bio: string | null;
  image_url: string | null;
  links: string | null;
  anchor_url: string | null;
  anchor_hash: string | null;
  anchor_status: string;
  last_synced_at: number;
  created_at: number;
}

/** Maps a raw D1 row to the Drep type (0/1 integers to booleans, links JSON to array). */
function rowToDrep(row: DrepRow): Drep {
  return {
    drepId: row.drep_id,
    hex: row.hex,
    hasScript: row.has_script === 1,
    status: row.status,
    active: row.active === 1,
    deposit: row.deposit,
    votingPower: row.voting_power,
    expiresEpochNo: row.expires_epoch_no,
    name: row.name,
    bio: row.bio,
    imageUrl: row.image_url,
    links: row.links != null ? (JSON.parse(row.links) as { label: string; uri: string }[]) : null,
    anchorUrl: row.anchor_url,
    anchorHash: row.anchor_hash,
    anchorStatus: row.anchor_status,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}

/**
 * Returns the drep row for the given drep id, or null if not found.
 * Parameterized SELECT; no string-interpolated SQL.
 */
export async function getDrepById(db: D1Database, drepId: string): Promise<Drep | null> {
  const row = await db
    .prepare('SELECT * FROM dreps WHERE drep_id = ?')
    .bind(drepId)
    .first<DrepRow>();
  return row ? rowToDrep(row) : null;
}

/**
 * Fetches multiple dreps by id in a single query (no N+1).
 * Builds a parameterized IN clause from the id list.
 * Returns an empty Map for empty input without querying D1.
 */
export async function getDrepsByIds(db: D1Database, ids: string[]): Promise<Map<string, Drep>> {
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => '?').join(', ');
  const rows = (
    await db
      .prepare(`SELECT * FROM dreps WHERE drep_id IN (${placeholders})`)
      .bind(...ids)
      .all<DrepRow>()
  ).results ?? [];

  const result = new Map<string, Drep>();
  for (const row of rows) {
    result.set(row.drep_id, rowToDrep(row));
  }
  return result;
}

/**
 * Inserts or replaces a drep row.
 * Uses INSERT OR REPLACE so re-syncing updates all fields atomically.
 * Booleans are stored as 0/1; links array is JSON-serialized or null.
 */
export async function upsertDrep(
  db: D1Database,
  args: {
    drepId: string;
    hex: string | null;
    hasScript: boolean;
    status: string;
    active: boolean;
    deposit: string | null;
    votingPower: string | null;
    expiresEpochNo: number | null;
    name: string | null;
    bio: string | null;
    imageUrl: string | null;
    links: { label: string; uri: string }[] | null;
    anchorUrl: string | null;
    anchorHash: string | null;
    anchorStatus: string;
    lastSyncedAt: number;
    createdAt: number;
  },
): Promise<void> {
  const linksJson = args.links != null ? JSON.stringify(args.links) : null;

  await db
    .prepare(
      `INSERT OR REPLACE INTO dreps
         (drep_id, hex, has_script, status, active, deposit, voting_power,
          expires_epoch_no, name, bio, image_url, links,
          anchor_url, anchor_hash, anchor_status, last_synced_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.drepId,
      args.hex,
      args.hasScript ? 1 : 0,
      args.status,
      args.active ? 1 : 0,
      args.deposit,
      args.votingPower,
      args.expiresEpochNo,
      args.name,
      args.bio,
      args.imageUrl,
      linksJson,
      args.anchorUrl,
      args.anchorHash,
      args.anchorStatus,
      args.lastSyncedAt,
      args.createdAt,
    )
    .run();
}

/**
 * Returns a Map of drep_id to stored anchor hash for every row in the dreps table.
 * Used by the sync worker to skip re-fetching CIP-119 anchors whose hash has not changed.
 */
export async function getSyncState(
  db: D1Database,
): Promise<Map<string, { anchorHash: string | null }>> {
  const rows = (
    await db.prepare('SELECT drep_id, anchor_hash FROM dreps').all<{ drep_id: string; anchor_hash: string | null }>()
  ).results ?? [];

  const result = new Map<string, { anchorHash: string | null }>();
  for (const row of rows) {
    result.set(row.drep_id, { anchorHash: row.anchor_hash });
  }
  return result;
}

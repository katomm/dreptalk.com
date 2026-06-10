/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the dreps table.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
// Stores on-chain DRep status and CIP-119 profile data synced from Koios.

import { sqlPlaceholders } from './sql.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';

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
  /** sha256 (hex) of the stored avatar bytes in R2 (avatars/<hash>), or null when not stored. */
  imageContentHash: string | null;
  /** The source image_url last successfully downloaded into R2. */
  imageStoredUrl: string | null;
  /** Unix ms of the last failed download attempt; NULL when never failed or after a success. */
  imageFetchFailedAt: number | null;
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
  image_content_hash: string | null;
  image_stored_url: string | null;
  image_fetch_failed_at: number | null;
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
    imageContentHash: row.image_content_hash,
    imageStoredUrl: row.image_stored_url,
    imageFetchFailedAt: row.image_fetch_failed_at,
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

  const placeholders = sqlPlaceholders(ids);
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
 * DRep ids whose profile is indexable per the SEO quality-gate: has on-chain
 * metadata (name/bio), has authored a forum post, or has recorded on-chain votes.
 * Used by the sitemap and the per-profile robots gate.
 */
export async function listIndexableDrepIds(db: D1Database): Promise<string[]> {
  const rows = (
    await db
      .prepare(
        `SELECT d.drep_id AS drep_id FROM dreps d
         WHERE d.name IS NOT NULL OR d.bio IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM users u JOIN posts p ON p.author_id = u.id
              WHERE u.drep_id = d.drep_id AND p.deleted = 0 AND p.hidden = 0
            )
            OR EXISTS (
              SELECT 1 FROM drep_votes v WHERE v.voter_id = d.drep_id AND v.voter_role = 'DRep'
            )`,
      )
      .all<{ drep_id: string }>()
  ).results ?? [];
  return rows.map((r) => r.drep_id);
}

/**
 * Directory listing: dreps ordered by numeric voting power desc, optionally
 * active-only and/or name-filtered, paginated. ~2k rows total, so the CAST sort
 * is cheap. Default limit 50, capped 100.
 */
export async function listDreps(
  db: D1Database,
  opts: { activeOnly?: boolean; query?: string; limit?: number; offset?: number },
): Promise<Drep[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.activeOnly) where.push('active = 1');
  // Never list the predefined pseudo-DReps (always-abstain / always-no-confidence).
  where.push(`drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})`);
  binds.push(...SPECIAL_DREP_IDS);
  const q = opts.query?.trim();
  if (q) {
    where.push('name LIKE ?');
    binds.push(`%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = (
    await db
      .prepare(
        `SELECT * FROM dreps ${whereSql}
         ORDER BY CAST(voting_power AS INTEGER) DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all<DrepRow>()
  ).results ?? [];
  return rows.map(rowToDrep);
}

/**
 * Inserts or updates a drep row in place (upsert keyed on drep_id).
 * Deliberately NOT INSERT OR REPLACE: REPLACE is DELETE+INSERT, which would
 * reassign the rowid and fire the dreps FTS delete/insert triggers on every
 * sync write. ON CONFLICT DO UPDATE keeps the row identity stable so the
 * WHEN-guarded FTS trigger only fires when name/bio actually change.
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
    imageContentHash: string | null;
    imageStoredUrl: string | null;
    imageFetchFailedAt: number | null;
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
      `INSERT INTO dreps
         (drep_id, hex, has_script, status, active, deposit, voting_power,
          expires_epoch_no, name, bio, image_url, image_content_hash,
          image_stored_url, image_fetch_failed_at, links, anchor_url,
          anchor_hash, anchor_status, last_synced_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(drep_id) DO UPDATE SET
         hex = excluded.hex,
         has_script = excluded.has_script,
         status = excluded.status,
         active = excluded.active,
         deposit = excluded.deposit,
         voting_power = excluded.voting_power,
         expires_epoch_no = excluded.expires_epoch_no,
         name = excluded.name,
         bio = excluded.bio,
         image_url = excluded.image_url,
         image_content_hash = excluded.image_content_hash,
         image_stored_url = excluded.image_stored_url,
         image_fetch_failed_at = excluded.image_fetch_failed_at,
         links = excluded.links,
         anchor_url = excluded.anchor_url,
         anchor_hash = excluded.anchor_hash,
         anchor_status = excluded.anchor_status,
         last_synced_at = excluded.last_synced_at,
         created_at = excluded.created_at`,
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
      args.imageContentHash,
      args.imageStoredUrl,
      args.imageFetchFailedAt,
      linksJson,
      args.anchorUrl,
      args.anchorHash,
      args.anchorStatus,
      args.lastSyncedAt,
      args.createdAt,
    )
    .run();
}

export interface DrepAvatarSourceRow {
  drepId: string;
  imageUrl: string;
}

/**
 * Work queue for the avatar store pass: DReps whose source image exists but is
 * not yet stored, or whose source URL changed since it was stored. Never-failed
 * rows come first, then failures oldest first, so a permanently failing source
 * rotates to the back of the queue instead of starving fresh work. drep_id
 * breaks ties for deterministic paging; capped by limit.
 */
export async function listDrepsNeedingAvatar(db: D1Database, limit: number): Promise<DrepAvatarSourceRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT drep_id, image_url FROM dreps
         WHERE image_url IS NOT NULL
           AND (image_stored_url IS NULL OR image_stored_url <> image_url)
         ORDER BY image_fetch_failed_at ASC NULLS FIRST, drep_id
         LIMIT ?`,
      )
      .bind(limit)
      .all<{ drep_id: string; image_url: string }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id, imageUrl: r.image_url }));
}

/**
 * Records a successful store: the R2 content hash and the source URL it came
 * from. image_stored_url is the idempotency key: listDrepsNeedingAvatar only
 * re-selects a row once the on-chain image_url differs from it again. Clears
 * the failure stamp so a later source change re-enters the queue as fresh work.
 */
export async function setDrepImageStored(
  db: D1Database,
  drepId: string,
  contentHash: string,
  storedUrl: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE dreps SET image_content_hash = ?, image_stored_url = ?,
         image_fetch_failed_at = NULL
       WHERE drep_id = ?`,
    )
    .bind(contentHash, storedUrl, drepId)
    .run();
}

/**
 * Stamps the given rows with the time of a failed download attempt, in one
 * batched UPDATE; listDrepsNeedingAvatar sorts stamped rows to the back of the
 * queue. No-op for an empty list.
 */
export async function markDrepImageFetchFailed(
  db: D1Database,
  drepIds: string[],
  failedAtMs: number,
): Promise<void> {
  if (drepIds.length === 0) return;
  await db
    .prepare(
      `UPDATE dreps SET image_fetch_failed_at = ?
       WHERE drep_id IN (${sqlPlaceholders(drepIds)})`,
    )
    .bind(failedAtMs, ...drepIds)
    .run();
}

/**
 * Clears the stored-avatar columns for rows whose on-chain image disappeared,
 * so the GC can reap the now-unreferenced R2 object. Returns rows cleared.
 */
export async function clearOrphanedImageStore(db: D1Database): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE dreps SET image_content_hash = NULL, image_stored_url = NULL
       WHERE image_url IS NULL AND image_content_hash IS NOT NULL`,
    )
    .run();
  return res.meta.changes ?? 0;
}

/** The set of content hashes still referenced by a dreps row (GC keep set). */
export async function listReferencedImageHashes(db: D1Database): Promise<Set<string>> {
  const rows = (
    await db
      .prepare('SELECT DISTINCT image_content_hash AS h FROM dreps WHERE image_content_hash IS NOT NULL')
      .all<{ h: string }>()
  ).results ?? [];
  return new Set(rows.map((r) => r.h));
}

export interface DrepPowerRow {
  drepId: string;
  name: string | null;
  votingPower: string | null;
}

/**
 * Active, non-special DReps with only the fields the concentration view needs,
 * ordered by numeric voting power desc. No pagination: the whole active set
 * (about 2k single-column rows) feeds one server-side aggregate, and the page
 * is edge cached so only cold renders pay it.
 */
export async function listDrepsForConcentration(db: D1Database): Promise<DrepPowerRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT drep_id, name, voting_power FROM dreps
         WHERE active = 1 AND drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})
         ORDER BY CAST(voting_power AS INTEGER) DESC`,
      )
      .bind(...SPECIAL_DREP_IDS)
      .all<{ drep_id: string; name: string | null; voting_power: string | null }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id, name: r.name, votingPower: r.voting_power }));
}

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
  /**
   * Voting power snapshot for the latest captured epoch and the one before it,
   * projected from drep_voting_power_history by the trend sync. Drive the list
   * delta chip; a null prev means no previous-epoch snapshot, so no chip. Owned by
   * the trend sync, not the profile upsert.
   */
  votingPowerSnapshot: string | null;
  votingPowerPrev: string | null;
  votingPowerSnapshotEpoch: number | null;
  /**
   * Number of stake keys currently vote-delegated to this DRep, and the unix-ms
   * timestamp of the last successful count. Owned by the delegator-count sync
   * phase, not the profile upsert; null until first counted.
   */
  delegatorCount: number | null;
  delegatorCountSyncedAt: number | null;
  expiresEpochNo: number | null;
  /** Epoch the DRep first registered (from /drep_updates), or null until backfilled. */
  registeredEpoch: number | null;
  name: string | null;
  /**
   * SEO-friendly profile path segment ("lisa-cardano-9zulj"), assigned once by
   * the sync backfill and sticky thereafter; null when the name yields no slug.
   */
  slug: string | null;
  bio: string | null;
  imageUrl: string | null;
  /** sha256 (hex) of the stored avatar bytes in R2 (avatars/<hash>), or null when not stored. */
  imageContentHash: string | null;
  /** The source image_url last successfully downloaded into R2. */
  imageStoredUrl: string | null;
  /** Unix ms of the last failed download attempt; NULL when never failed or after a success. */
  imageFetchFailedAt: number | null;
  links: { label: string; uri: string }[] | null;
  motivations: string | null;
  qualifications: string | null;
  paymentAddress: string | null;
  /** CIP-119 doNotList flag; round-tripped but not honored by the listing. */
  doNotList: boolean;
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
  voting_power_snapshot: string | null;
  voting_power_prev: string | null;
  voting_power_snapshot_epoch: number | null;
  delegator_count: number | null;
  delegator_count_synced_at: number | null;
  expires_epoch_no: number | null;
  registered_epoch: number | null;
  name: string | null;
  slug: string | null;
  bio: string | null;
  image_url: string | null;
  image_content_hash: string | null;
  image_stored_url: string | null;
  image_fetch_failed_at: number | null;
  links: string | null;
  motivations: string | null;
  qualifications: string | null;
  payment_address: string | null;
  do_not_list: number;
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
    votingPowerSnapshot: row.voting_power_snapshot,
    votingPowerPrev: row.voting_power_prev,
    votingPowerSnapshotEpoch: row.voting_power_snapshot_epoch,
    delegatorCount: row.delegator_count,
    delegatorCountSyncedAt: row.delegator_count_synced_at,
    expiresEpochNo: row.expires_epoch_no,
    registeredEpoch: row.registered_epoch,
    name: row.name,
    slug: row.slug,
    bio: row.bio,
    imageUrl: row.image_url,
    imageContentHash: row.image_content_hash,
    imageStoredUrl: row.image_stored_url,
    imageFetchFailedAt: row.image_fetch_failed_at,
    links: row.links != null ? (JSON.parse(row.links) as { label: string; uri: string }[]) : null,
    motivations: row.motivations,
    qualifications: row.qualifications,
    paymentAddress: row.payment_address,
    doNotList: row.do_not_list === 1,
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
 * Resolves a profile-path segment to its drep row: the raw drep id (legacy
 * URLs, pasted ids) or the assigned slug. One query; both columns are unique
 * (PK / unique index) and their value spaces are disjoint, since every slug
 * contains a hyphen and bech32 ids never do.
 */
export async function getDrepByIdOrSlug(db: D1Database, key: string): Promise<Drep | null> {
  const row = await db
    .prepare('SELECT * FROM dreps WHERE drep_id = ?1 OR slug = ?1 LIMIT 1')
    .bind(key)
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
 * Profile path segments (slug when assigned, else drep id) of DReps indexable
 * per the SEO quality-gate: has on-chain metadata (name/bio), has authored a
 * forum post, or has recorded on-chain votes.
 * Used by the sitemap and the per-profile robots gate.
 */
export async function listIndexableDrepIds(db: D1Database): Promise<string[]> {
  const rows = (
    await db
      .prepare(
        `SELECT COALESCE(d.slug, d.drep_id) AS drep_id FROM dreps d
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
 * active-only, paginated. ~2k rows total, so the CAST sort is cheap.
 * Default limit 50, capped 100. Name search is handled by the global FTS palette.
 */
export async function listDreps(
  db: D1Database,
  opts: { activeOnly?: boolean; limit?: number; offset?: number; sort?: 'power' | 'delegators' },
): Promise<Drep[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.activeOnly) where.push('active = 1');
  // Never list the predefined pseudo-DReps (always-abstain / always-no-confidence).
  where.push(`drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})`);
  binds.push(...SPECIAL_DREP_IDS);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Whitelisted sort keys only (never interpolate user input). Delegator sort keeps
  // voting power as the tie-break and pushes never-counted rows (NULL) to the end.
  const orderSql =
    opts.sort === 'delegators'
      ? 'ORDER BY delegator_count DESC NULLS LAST, CAST(voting_power AS INTEGER) DESC'
      : 'ORDER BY CAST(voting_power AS INTEGER) DESC';
  const rows = (
    await db
      .prepare(
        `SELECT * FROM dreps ${whereSql}
         ${orderSql}
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all<DrepRow>()
  ).results ?? [];
  return rows.map(rowToDrep);
}

/**
 * Drep ids currently marked active. The sync diffs this against the registered
 * enumeration to find rows that still claim active voting power but have left the
 * registered set (the DRep deregistered). Excludes the pseudo-DReps, which are
 * standing options, never real voters.
 */
export async function listActiveDrepIds(db: D1Database): Promise<string[]> {
  const rows = (
    await db
      .prepare(
        `SELECT drep_id FROM dreps
         WHERE active = 1 AND drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})`,
      )
      .bind(...SPECIAL_DREP_IDS)
      .all<{ drep_id: string }>()
  ).results ?? [];
  return rows.map((r) => r.drep_id);
}

/**
 * Marks DReps that have left the registered set as inactive: refreshes ONLY the
 * chain-derived columns (status, active=0, voting power, deposit, expiry) and the
 * sync timestamp from a fresh drep_info, leaving the profile (name/bio/avatar/
 * anchor/slug) untouched so a retired DRep stays viewable for its governance
 * history. A plain UPDATE keeps the rowid stable, and name/bio are not touched,
 * so the WHEN-guarded FTS triggers do not fire. Batched; no-op on an empty list.
 * Returns the number of rows updated.
 */
export async function deactivateDreps(
  db: D1Database,
  rows: {
    drepId: string;
    status: string;
    votingPower: string | null;
    deposit: string | null;
    expiresEpochNo: number | null;
    lastSyncedAt: number;
  }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const stmts = rows.map((r) =>
    db
      .prepare(
        `UPDATE dreps SET status = ?, active = 0, voting_power = ?, deposit = ?,
           expires_epoch_no = ?, last_synced_at = ?
         WHERE drep_id = ?`,
      )
      .bind(r.status, r.votingPower, r.deposit, r.expiresEpochNo, r.lastSyncedAt, r.drepId),
  );
  await db.batch(stmts);
  return rows.length;
}

/**
 * Writes delegator counts for the given DReps in one batch (one single-row
 * UPDATE per DRep, well under D1's 100-bound-param-per-query limit). Touches only
 * the two count columns, so the WHEN-guarded FTS triggers never fire. No-op on an
 * empty list. Returns the number of rows written.
 */
export async function updateDrepDelegatorCounts(
  db: D1Database,
  rows: { drepId: string; delegatorCount: number; syncedAt: number }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const stmts = rows.map((r) =>
    db
      .prepare(
        `UPDATE dreps SET delegator_count = ?, delegator_count_synced_at = ?
         WHERE drep_id = ?`,
      )
      .bind(r.delegatorCount, r.syncedAt, r.drepId),
  );
  await db.batch(stmts);
  return rows.length;
}

/**
 * The DReps most in need of a delegator-count refresh: never-counted rows first
 * (NULL synced_at), then oldest count first. Excludes the predefined pseudo-DReps
 * (always-abstain / always-no-confidence), which have no delegators.
 */
export async function listDrepsForDelegatorCountRefresh(
  db: D1Database,
  limit: number,
): Promise<{ drepId: string }[]> {
  const rows = (
    await db
      .prepare(
        `SELECT drep_id FROM dreps
         WHERE drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})
         ORDER BY delegator_count_synced_at ASC NULLS FIRST, drep_id
         LIMIT ?`,
      )
      .bind(...SPECIAL_DREP_IDS, limit)
      .all<{ drep_id: string }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id }));
}

/**
 * Inserts or updates a drep row in place (upsert keyed on drep_id).
 * Deliberately NOT INSERT OR REPLACE: REPLACE is DELETE+INSERT, which would
 * reassign the rowid and fire the dreps FTS delete/insert triggers on every
 * sync write. ON CONFLICT DO UPDATE keeps the row identity stable so the
 * WHEN-guarded FTS trigger only fires when name/bio actually change.
 * Booleans are stored as 0/1; links array is JSON-serialized or null.
 * created_at is pinned to the existing row on update: creation time is immutable at the DB layer.
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
    motivations: string | null;
    qualifications: string | null;
    paymentAddress: string | null;
    doNotList: boolean;
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
          image_stored_url, image_fetch_failed_at, links,
          motivations, qualifications, payment_address, do_not_list,
          anchor_url, anchor_hash, anchor_status, last_synced_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         motivations = excluded.motivations,
         qualifications = excluded.qualifications,
         payment_address = excluded.payment_address,
         do_not_list = excluded.do_not_list,
         anchor_url = excluded.anchor_url,
         anchor_hash = excluded.anchor_hash,
         anchor_status = excluded.anchor_status,
         last_synced_at = excluded.last_synced_at,
         created_at = dreps.created_at`,
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
      args.motivations,
      args.qualifications,
      args.paymentAddress,
      args.doNotList ? 1 : 0,
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
 * breaks ties for deterministic paging; capped by limit. Rows that have failed
 * maxAttempts times are excluded: the source is treated as permanently broken so
 * the pass stops retrying it and the dreps sync is not pinned at 'partial'.
 */
export async function listDrepsNeedingAvatar(
  db: D1Database,
  limit: number,
  maxAttempts: number,
): Promise<DrepAvatarSourceRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT drep_id, image_url FROM dreps
         WHERE image_url IS NOT NULL
           AND (image_stored_url IS NULL OR image_stored_url <> image_url)
           AND image_fetch_attempts < ?
         ORDER BY image_fetch_failed_at ASC NULLS FIRST, drep_id
         LIMIT ?`,
      )
      .bind(maxAttempts, limit)
      .all<{ drep_id: string; image_url: string }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id, imageUrl: r.image_url }));
}

/**
 * Count of DReps the avatar pass has permanently given up on: an image URL that
 * is still unstored after maxAttempts failed fetches. These drop out of
 * listDrepsNeedingAvatar, so the status page surfaces the count.
 */
export async function countGivenUpAvatars(db: D1Database, maxAttempts: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM dreps
       WHERE image_url IS NOT NULL
         AND (image_stored_url IS NULL OR image_stored_url <> image_url)
         AND image_fetch_attempts >= ?`,
    )
    .bind(maxAttempts)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
         image_fetch_failed_at = NULL, image_fetch_attempts = 0
       WHERE drep_id = ?`,
    )
    .bind(contentHash, storedUrl, drepId)
    .run();
}

/**
 * Optimistic profile write for a DRep who just submitted an update_drep tx.
 * Updates only the display and anchor columns of that one row, leaving the
 * chain-derived fields (status, voting power, deposit, slug, registered epoch)
 * untouched. The values are derived from the same hosted document the wallet
 * anchored, parsed with the same extractCip119Profile the sync uses, so the
 * later sync sees an unchanged row and skips it. A plain UPDATE keeps the rowid
 * stable, so the FTS triggers reindex name/bio in place. Returns true when a
 * row existed and was updated.
 */
export async function updateDrepProfileFromAnchor(
  db: D1Database,
  args: {
    drepId: string;
    name: string | null;
    bio: string | null;
    links: { label: string; uri: string }[] | null;
    motivations: string | null;
    qualifications: string | null;
    paymentAddress: string | null;
    doNotList: boolean;
    imageUrl: string | null;
    imageContentHash: string | null;
    imageStoredUrl: string | null;
    anchorUrl: string | null;
    anchorHash: string | null;
    anchorStatus: string;
    lastSyncedAt: number;
  },
): Promise<boolean> {
  const linksJson = args.links != null ? JSON.stringify(args.links) : null;
  const res = await db
    .prepare(
      `UPDATE dreps SET
         name = ?, bio = ?, links = ?, image_url = ?,
         image_content_hash = ?, image_stored_url = ?, image_fetch_failed_at = NULL,
         motivations = ?, qualifications = ?, payment_address = ?, do_not_list = ?,
         anchor_url = ?, anchor_hash = ?, anchor_status = ?, last_synced_at = ?
       WHERE drep_id = ?`,
    )
    .bind(
      args.name,
      args.bio,
      linksJson,
      args.imageUrl,
      args.imageContentHash,
      args.imageStoredUrl,
      args.motivations,
      args.qualifications,
      args.paymentAddress,
      args.doNotList ? 1 : 0,
      args.anchorUrl,
      args.anchorHash,
      args.anchorStatus,
      args.lastSyncedAt,
      args.drepId,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
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
      `UPDATE dreps SET image_fetch_failed_at = ?, image_fetch_attempts = image_fetch_attempts + 1
       WHERE drep_id IN (${sqlPlaceholders(drepIds)})`,
    )
    .bind(failedAtMs, ...drepIds)
    .run();
}

/**
 * Clears the stored-avatar columns for rows whose on-chain image disappeared,
 * so the GC can reap the now-unreferenced R2 object. Returns rows cleared.
 *
 * Only URL-sourced avatars are orphaned: image_stored_url holds the source URL
 * an avatar was fetched from, so a non-null one with image_url now gone means
 * the link was removed. Inline data: avatars carry image_stored_url null (they
 * are decoded from the doc, never fetched), so the IS NOT NULL guard keeps them
 * out, otherwise the avatar pass would wipe them the same run the sync stores them.
 */
export async function clearOrphanedImageStore(db: D1Database): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE dreps SET image_content_hash = NULL, image_stored_url = NULL
       WHERE image_url IS NULL AND image_content_hash IS NOT NULL AND image_stored_url IS NOT NULL`,
    )
    .run();
  return res.meta.changes ?? 0;
}

/** DRep ids whose registration epoch has not been backfilled yet. */
export async function listDrepIdsMissingRegisteredEpoch(db: D1Database): Promise<string[]> {
  const rows = (
    await db.prepare('SELECT drep_id FROM dreps WHERE registered_epoch IS NULL').all<{ drep_id: string }>()
  ).results ?? [];
  return rows.map((r) => r.drep_id);
}

/**
 * Sets registered_epoch for the given DReps in one batch, only where it is still
 * NULL (idempotent; never overwrites an already-resolved value). Returns the
 * number of statements issued. No-op for an empty list.
 */
export async function setRegisteredEpochs(
  db: D1Database,
  entries: { drepId: string; epoch: number }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const stmts = entries.map((e) =>
    db
      .prepare('UPDATE dreps SET registered_epoch = ? WHERE drep_id = ? AND registered_epoch IS NULL')
      .bind(e.epoch, e.drepId),
  );
  await db.batch(stmts);
  return entries.length;
}

/**
 * Work queue for the slug backfill: named DReps without an assigned slug.
 * Steady state is zero rows (one indexed read); only newly named DReps appear.
 */
export async function listDrepsMissingSlug(
  db: D1Database,
): Promise<{ drepId: string; name: string | null }[]> {
  const rows = (
    await db
      .prepare('SELECT drep_id, name FROM dreps WHERE name IS NOT NULL AND slug IS NULL')
      .all<{ drep_id: string; name: string | null }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id, name: r.name }));
}

/** Every assigned slug, as the taken-set for collision-free assignment. */
export async function listAssignedSlugs(db: D1Database): Promise<Set<string>> {
  const rows = (
    await db.prepare('SELECT slug FROM dreps WHERE slug IS NOT NULL').all<{ slug: string }>()
  ).results ?? [];
  return new Set(rows.map((r) => r.slug));
}

/**
 * Assigns the given slugs in one batch, only where none is set yet (sticky:
 * never overwrites, so a profile URL can never change once minted). Returns
 * the number of statements issued. No-op for an empty list.
 */
export async function setDrepSlugs(
  db: D1Database,
  entries: { drepId: string; slug: string }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const stmts = entries.map((e) =>
    db
      .prepare('UPDATE dreps SET slug = ? WHERE drep_id = ? AND slug IS NULL')
      .bind(e.slug, e.drepId),
  );
  await db.batch(stmts);
  return entries.length;
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
  slug: string | null;
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
        `SELECT drep_id, name, slug, voting_power FROM dreps
         WHERE active = 1 AND drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})
         ORDER BY CAST(voting_power AS INTEGER) DESC`,
      )
      .bind(...SPECIAL_DREP_IDS)
      .all<{ drep_id: string; name: string | null; slug: string | null; voting_power: string | null }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id, name: r.name, slug: r.slug, votingPower: r.voting_power }));
}

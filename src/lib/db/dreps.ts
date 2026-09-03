/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the dreps table.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.
// Stores on-chain DRep status and CIP-119 profile data synced from Koios.

import { sqlPlaceholders, chunked, D1_MAX_BINDS } from './sql.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';
import { computeVotingPowerDelta } from '../dreps/votingPowerTrend.js';
import { buildJobInsert } from './fanoutJobs.js';

export type EffectiveDrepStatus = 'active' | 'inactive';

/**
 * Normalizes a DRep's on-chain state to the two effective states the delegator
 * status-change notification is keyed on. Derived from the `active` boolean, not
 * the raw Koios status string, so any active <-> inactive flip fires exactly one
 * event regardless of how the raw status is spelled.
 */
export function effectiveDrepStatus(active: boolean): EffectiveDrepStatus {
  return active ? 'active' : 'inactive';
}

export interface DrepStatusFanoutOptions {
  /**
   * When present, the set of DRep ids that have at least one follower to notify.
   * Passing it turns on delegator fan-out: when a followed DRep's effective status
   * (active/inactive) changes, a delegator_drep_status_changed job is inserted in
   * the SAME batch as its status write, so job creation is atomic with the write.
   * Omit it (most sync callers do) to write status without emitting any events.
   */
  followedDrepIds?: Set<string>;
}

// Max drep ids per old-state SELECT in deactivateDreps. D1 caps bound params at
// 100 per query; the IN clause binds one id each, so 100 ids fit exactly.
const OLD_STATE_CHUNK = 100;

/**
 * Builds the status-change fan-out job INSERT for a followed DRep whose effective
 * state changed, or null when no job is due (same effective state). Never executes:
 * the caller drops it into the same batch as the status write, so the outbox row
 * commits atomically with the write it fans out from. lastSyncedAt is unix
 * milliseconds; source_time / created_at are seconds.
 */
function buildDrepStatusJob(
  db: D1Database,
  args: {
    drepId: string;
    oldActive: boolean;
    oldStatus: string;
    newActive: boolean;
    newStatus: string;
    lastSyncedAt: number;
  },
): D1PreparedStatement | null {
  const fromEff = effectiveDrepStatus(args.oldActive);
  const toEff = effectiveDrepStatus(args.newActive);
  if (fromEff === toEff) return null;

  const sourceTime = Math.floor(args.lastSyncedAt / 1000);
  const payload = JSON.stringify({
    sourceTime,
    drepId: args.drepId,
    from: { effective: fromEff, status: args.oldStatus },
    to: { effective: toEff, status: args.newStatus },
  });
  return buildJobInsert(db, {
    eventKey: `drep-status:${args.drepId}:${fromEff}:${toEff}:${sourceTime}`,
    eventType: 'delegator_drep_status_changed',
    subjectId: args.drepId,
    sourceTime,
    payload,
    createdAt: sourceTime,
  });
}

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
  /**
   * Unix seconds of the newest 'registered' action, i.e. the start of the
   * current registration period ("Registered since"). Deliberately not the
   * historical first registration; registeredEpoch keeps that role for the
   * participation stats. Null until backfilled.
   */
  registeredAt: number | null;
  /**
   * Unix seconds of the newest on-chain metadata change: the latest 'updated'
   * action from the backfill (falling back to the registration time when a DRep
   * never updated), then kept fresh by the sync stamping it on anchor changes.
   * Null until backfilled.
   */
  metadataLastUpdatedAt: number | null;
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
  /**
   * PROFILE_EXTRACT_VERSION the profile fields were last extracted at. The sync
   * takes the no-fetch reuse path only when this equals the current version, so
   * bumping the extractor re-fetches every row once. 0 for rows written before
   * the column existed.
   */
  profileExtractVersion: number;
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
  registered_at: number | null;
  metadata_last_updated_at: number | null;
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
  profile_extract_version: number;
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
    registeredAt: row.registered_at,
    metadataLastUpdatedAt: row.metadata_last_updated_at,
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
    // COALESCE guards a NULL from a row inserted before the column's DEFAULT.
    profileExtractVersion: row.profile_extract_version ?? 0,
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
 * Fetches multiple dreps by id in one batched round-trip (no N+1).
 * Chunked to D1's 100-bind cap, like getUsersByIds and getPoolsByIds: the
 * CIP-100 thread manifest passes one id per non-deleted post in a whole topic,
 * unpaginated, so the list is unbounded and can exceed a single IN clause.
 * Returns an empty Map for empty input without querying D1.
 */
export async function getDrepsByIds(db: D1Database, ids: string[]): Promise<Map<string, Drep>> {
  if (ids.length === 0) return new Map();

  const stmts = chunked(ids, D1_MAX_BINDS).map((chunk) =>
    db.prepare(`SELECT * FROM dreps WHERE drep_id IN (${sqlPlaceholders(chunk)})`).bind(...chunk),
  );
  const batched = await db.batch<DrepRow>(stmts);

  const result = new Map<string, Drep>();
  for (const res of batched) {
    for (const row of res.results ?? []) {
      result.set(row.drep_id, rowToDrep(row));
    }
  }
  return result;
}

/**
 * Profile path segments (slug when assigned, else drep id) of DReps indexable
 * per the SEO quality-gate: has on-chain metadata (name/bio) or has authored a
 * forum post that is still reachable. A recorded vote alone does not qualify
 * (see isIndexableProfile): nameless vote-only profiles are thin and never rank,
 * so they are kept out of the sitemap. A post whose thread was deleted does not
 * qualify either, which keeps this in step with the profile page: it counts
 * posts through getPostsByAuthor, which drops deleted threads, so without the
 * topic join the sitemap would list a profile the page itself marks noindex.
 * This WHERE must mirror isIndexableProfile in dreps/profile.ts.
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
                JOIN topics t ON t.id = p.topic_id
              WHERE u.drep_id = d.drep_id AND p.deleted = 0 AND p.hidden = 0 AND t.deleted = 0
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
 * The DReps whose voting power moved most between the previous epoch snapshot and
 * the latest one, split into gainers and losers. Ranked by the absolute lovelace
 * delta (snapshot - prev), so the ranking reflects real shifts in the power
 * landscape rather than a tiny DRep's large percentage swing. Requires both
 * snapshots present and excludes the pseudo-DReps; flat (unchanged) rows appear in
 * neither list. `epoch` is the latest snapshot epoch, for the page's "this epoch"
 * label. Default limit 10 per list, capped 25.
 */
export async function listVotingPowerMovers(
  db: D1Database,
  opts?: { limit?: number },
): Promise<{ gainers: Drep[]; losers: Drep[]; epoch: number | null }> {
  const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25);
  // Both snapshots must be present and numeric for a delta to exist. The pseudo-
  // DReps (always-abstain / always-no-confidence) are standing options, not movers.
  const base = `FROM dreps
     WHERE voting_power_snapshot IS NOT NULL AND voting_power_snapshot <> ''
       AND voting_power_prev IS NOT NULL AND voting_power_prev <> ''
       AND drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})`;
  const delta = 'CAST(voting_power_snapshot AS INTEGER) - CAST(voting_power_prev AS INTEGER)';
  const [gainRes, lossRes] = await Promise.all([
    db
      .prepare(`SELECT * ${base} AND ${delta} > 0 ORDER BY ${delta} DESC LIMIT ?`)
      .bind(...SPECIAL_DREP_IDS, limit)
      .all<DrepRow>(),
    db
      .prepare(`SELECT * ${base} AND ${delta} < 0 ORDER BY ${delta} ASC LIMIT ?`)
      .bind(...SPECIAL_DREP_IDS, limit)
      .all<DrepRow>(),
  ]);
  const gainers = (gainRes.results ?? []).map(rowToDrep);
  const losers = (lossRes.results ?? []).map(rowToDrep);
  // The snapshot epoch is a global per-sync value; every mover row carries it, so
  // read it off the loaded rows instead of a separate MAX() scan over ~2k dreps.
  const epoch = gainers[0]?.votingPowerSnapshotEpoch ?? losers[0]?.votingPowerSnapshotEpoch ?? null;
  return { gainers, losers, epoch };
}

export interface DrepRanking {
  drep: Drep;
  /**
   * 1-based position within the same filtered/sorted listing, or null when the
   * DRep isn't part of it: a special pseudo-DRep, an inactive DRep while the view
   * is active-only, or (under the delegator sort) a DRep with no counted delegators.
   */
  rank: number | null;
  /** Size of the listing the rank sits within. */
  total: number;
}

/**
 * Where a single DRep stands in the directory listing, for the "this is you" row
 * a logged-in DRep sees pinned above the table. Mirrors listDreps' filter (special
 * DReps excluded, active-only optional) and sort (power, or delegators with the
 * same NULLS-last / power tie-break) so the rank matches what the table shows. The
 * comparisons run against the DRep's own value via a subquery, keeping all
 * lovelace math in SQLite (64-bit) rather than risking JS Number precision.
 */
export async function getDrepRanking(
  db: D1Database,
  drepId: string,
  opts: { activeOnly: boolean; sort: 'power' | 'delegators' },
): Promise<DrepRanking | null> {
  const drep = await getDrepById(db, drepId);
  if (!drep) return null;

  const where: string[] = [`drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})`];
  const binds: unknown[] = [...SPECIAL_DREP_IDS];
  if (opts.activeOnly) where.push('active = 1');
  const whereSql = `WHERE ${where.join(' AND ')}`;

  // "Ahead" = ranked strictly above self in the listing's sort. Comparisons run
  // against the DRep's own value via a subquery, keeping lovelace math in SQLite
  // (64-bit) rather than risking JS Number precision.
  const aheadSql =
    opts.sort === 'delegators'
      ? `delegator_count IS NOT NULL AND (
           delegator_count > (SELECT delegator_count FROM dreps WHERE drep_id = ?)
           OR ( delegator_count = (SELECT delegator_count FROM dreps WHERE drep_id = ?)
                AND CAST(voting_power AS INTEGER) > (SELECT CAST(voting_power AS INTEGER) FROM dreps WHERE drep_id = ?) )
         )`
      : `CAST(voting_power AS INTEGER) > (SELECT CAST(voting_power AS INTEGER) FROM dreps WHERE drep_id = ?)`;
  const aheadBinds = opts.sort === 'delegators' ? [drepId, drepId, drepId] : [drepId];

  // total and ahead in one round-trip (as getDrepMoverStanding does). The aheadSql
  // `?` sit in the SELECT, so their binds precede the WHERE's NOT IN list.
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ${aheadSql} THEN 1 ELSE 0 END) AS ahead
         FROM dreps ${whereSql}`,
    )
    .bind(...aheadBinds, ...binds)
    .first<{ total: number; ahead: number | null }>();
  const total = row?.total ?? 0;

  // No meaningful rank: a special pseudo-DRep, an inactive DRep under an active-only
  // view, or an uncounted DRep under the delegator sort (which lists NULLS last).
  const unranked =
    (SPECIAL_DREP_IDS as readonly string[]).includes(drepId) ||
    (opts.activeOnly && !drep.active) ||
    (opts.sort === 'delegators' && drep.delegatorCount == null);
  return { drep, rank: unranked ? null : (row?.ahead ?? 0) + 1, total };
}

export interface DrepMoverStanding {
  drep: Drep;
  direction: 'up' | 'down' | 'flat';
  /** Rank among movers in the same direction (1 = biggest), or null when flat or a snapshot is missing. */
  rank: number | null;
  /** Count of movers in that direction this epoch. */
  total: number;
  /** Latest snapshot epoch this standing is for. */
  epoch: number | null;
}

/**
 * A single DRep's own place in the movers-of-the-epoch ranking, for the pinned
 * "your movement" row on /dreps/movers. Ranking mirrors listVotingPowerMovers:
 * absolute lovelace delta (snapshot - prev), split by direction. Flat rows, a
 * missing snapshot, and the pseudo-DReps carry no standing. The magnitude compare
 * uses the DRep's own delta via a subquery so the math stays in SQLite.
 */
export async function getDrepMoverStanding(
  db: D1Database,
  drepId: string,
): Promise<DrepMoverStanding | null> {
  const drep = await getDrepById(db, drepId);
  if (!drep) return null;

  const epoch = drep.votingPowerSnapshotEpoch;
  // Reuse the shared delta helper for the direction: it returns null on a missing/
  // non-numeric snapshot, exactly the no-standing guard. A flat move and the pseudo-
  // DReps also carry no standing.
  const delta = computeVotingPowerDelta(drep.votingPowerSnapshot, drep.votingPowerPrev);
  if (delta == null || delta.direction === 'flat' || (SPECIAL_DREP_IDS as readonly string[]).includes(drepId)) {
    return { drep, direction: 'flat', rank: null, total: 0, epoch };
  }
  const direction = delta.direction;

  const base = `FROM dreps
     WHERE voting_power_snapshot IS NOT NULL AND voting_power_snapshot <> ''
       AND voting_power_prev IS NOT NULL AND voting_power_prev <> ''
       AND drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})`;
  const deltaExpr = '(CAST(voting_power_snapshot AS INTEGER) - CAST(voting_power_prev AS INTEGER))';
  const selfDelta = `(SELECT ${deltaExpr} FROM dreps WHERE drep_id = ?)`;
  // A "bigger" mover in the same direction is further from zero: strictly greater
  // among gainers, strictly less among losers (matching the ASC loser ordering).
  const dirCond = direction === 'up' ? `${deltaExpr} > 0` : `${deltaExpr} < 0`;
  const aheadCond = direction === 'up' ? `${deltaExpr} > ${selfDelta}` : `${deltaExpr} < ${selfDelta}`;

  // Bind order follows the `?` positions in the SQL string: the selfDelta subquery
  // sits in the SELECT (aheadCond), so drepId binds before the base's NOT IN list.
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN ${dirCond} THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN ${dirCond} AND ${aheadCond} THEN 1 ELSE 0 END) AS ahead
       ${base}`,
    )
    .bind(drepId, ...SPECIAL_DREP_IDS)
    .first<{ total: number | null; ahead: number | null }>();
  return {
    drep,
    direction,
    rank: (row?.ahead ?? 0) + 1,
    total: row?.total ?? 0,
    epoch,
  };
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
  opts?: DrepStatusFanoutOptions,
): Promise<number> {
  if (rows.length === 0) return 0;
  const updateStmts = rows.map((r) =>
    db
      .prepare(
        `UPDATE dreps SET status = ?, active = 0, voting_power = ?, deposit = ?,
           expires_epoch_no = ?, last_synced_at = ?
         WHERE drep_id = ?`,
      )
      .bind(r.status, r.votingPower, r.deposit, r.expiresEpochNo, r.lastSyncedAt, r.drepId),
  );

  // Fan-out jobs for followed rows whose effective state actually changes. The new
  // state is always inactive here, so a job is due only for a followed row that was
  // active before. Old states are loaded for all followed rows in one batched SELECT
  // per chunk (not one per DRep), and every job lands in the same batch as the
  // UPDATEs so status and job commit atomically.
  const jobStmts: D1PreparedStatement[] = [];
  const followed = opts?.followedDrepIds;
  if (followed && followed.size > 0) {
    const followedRows = rows.filter((r) => followed.has(r.drepId));
    if (followedRows.length > 0) {
      const oldById = new Map<string, { active: number; status: string }>();
      for (let i = 0; i < followedRows.length; i += OLD_STATE_CHUNK) {
        const ids = followedRows.slice(i, i + OLD_STATE_CHUNK).map((r) => r.drepId);
        const res = await db
          .prepare(`SELECT drep_id, active, status FROM dreps WHERE drep_id IN (${sqlPlaceholders(ids)})`)
          .bind(...ids)
          .all<{ drep_id: string; active: number; status: string }>();
        for (const row of res.results ?? []) oldById.set(row.drep_id, { active: row.active, status: row.status });
      }
      for (const r of followedRows) {
        const old = oldById.get(r.drepId);
        if (!old) continue; // No prior row: a first-seen id has no transition.
        const jobStmt = buildDrepStatusJob(db, {
          drepId: r.drepId,
          oldActive: old.active === 1,
          oldStatus: old.status,
          newActive: false,
          newStatus: r.status,
          lastSyncedAt: r.lastSyncedAt,
        });
        if (jobStmt) jobStmts.push(jobStmt);
      }
    }
  }

  await db.batch([...updateStmts, ...jobStmts]);
  return rows.length;
}

/** Column values for a drep upsert (see upsertDrep for the write semantics). */
export interface UpsertDrepArgs {
  drepId: string;
  hex: string | null;
  hasScript: boolean;
  status: string;
  active: boolean;
  deposit: string | null;
  votingPower: string | null;
  expiresEpochNo: number | null;
  // Chain-sync-owned (from /drep_info's live_delegator_count); optional so the
  // many callers that do not touch delegator data can omit them.
  delegatorCount?: number | null;
  delegatorCountSyncedAt?: number | null;
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
  profileExtractVersion: number;
  /**
   * Unix seconds of the newest observed on-chain metadata change. Optional so
   * callers outside the chain sync can omit it; the upsert then preserves the
   * stored value (COALESCE), it never nulls out a backfilled date.
   */
  metadataLastUpdatedAt?: number | null;
  lastSyncedAt: number;
  createdAt: number;
}

/** The single ON CONFLICT DO UPDATE upsert for one drep row, as a prepared (not
 *  executed) statement so it can be run alone or dropped into a db.batch. */
function buildDrepUpsertStatement(db: D1Database, args: UpsertDrepArgs): D1PreparedStatement {
  const linksJson = args.links != null ? JSON.stringify(args.links) : null;

  return db
    .prepare(
      `INSERT INTO dreps
         (drep_id, hex, has_script, status, active, deposit, voting_power,
          expires_epoch_no, delegator_count, delegator_count_synced_at,
          name, bio, image_url, image_content_hash,
          image_stored_url, image_fetch_failed_at, links,
          motivations, qualifications, payment_address, do_not_list,
          anchor_url, anchor_hash, anchor_status, profile_extract_version,
          metadata_last_updated_at, last_synced_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(drep_id) DO UPDATE SET
         hex = excluded.hex,
         has_script = excluded.has_script,
         status = excluded.status,
         active = excluded.active,
         deposit = excluded.deposit,
         voting_power = excluded.voting_power,
         expires_epoch_no = excluded.expires_epoch_no,
         delegator_count = excluded.delegator_count,
         delegator_count_synced_at = excluded.delegator_count_synced_at,
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
         profile_extract_version = excluded.profile_extract_version,
         metadata_last_updated_at = COALESCE(excluded.metadata_last_updated_at, dreps.metadata_last_updated_at),
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
      args.delegatorCount ?? null,
      args.delegatorCountSyncedAt ?? null,
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
      args.profileExtractVersion,
      args.metadataLastUpdatedAt ?? null,
      args.lastSyncedAt,
      args.createdAt,
    );
}

/**
 * Inserts or updates a drep row in place (upsert keyed on drep_id).
 * Deliberately NOT INSERT OR REPLACE: REPLACE is DELETE+INSERT, which would
 * reassign the rowid and fire the dreps FTS delete/insert triggers on every
 * sync write. ON CONFLICT DO UPDATE keeps the row identity stable so the
 * WHEN-guarded FTS trigger only fires when name/bio actually change.
 * Booleans are stored as 0/1; links array is JSON-serialized or null.
 * created_at is pinned to the existing row on update: creation time is immutable at the DB layer.
 *
 * When opts.followedDrepIds contains this drep and its effective status
 * (active/inactive) changes from the stored row, a delegator_drep_status_changed
 * fan-out job is committed in the SAME batch as the upsert. The old-state SELECT
 * and the batch only happen for a followed drep; every other write keeps the
 * single-statement fast path.
 */
export async function upsertDrep(
  db: D1Database,
  args: UpsertDrepArgs,
  opts?: DrepStatusFanoutOptions,
): Promise<void> {
  const upsertStmt = buildDrepUpsertStatement(db, args);

  // Fast path: no fan-out work for an unfollowed drep. One prepared statement,
  // one round-trip, exactly as before this feature.
  const followed = opts?.followedDrepIds;
  if (followed?.has(args.drepId)) {
    // Read the OLD row's effective state (only for a followed drep). A missing row
    // is a first creation, which is not a transition, so it emits no job.
    const old = await db
      .prepare('SELECT active, status FROM dreps WHERE drep_id = ?')
      .bind(args.drepId)
      .first<{ active: number; status: string }>();
    if (old) {
      const jobStmt = buildDrepStatusJob(db, {
        drepId: args.drepId,
        oldActive: old.active === 1,
        oldStatus: old.status,
        newActive: args.active,
        newStatus: args.status,
        lastSyncedAt: args.lastSyncedAt,
      });
      if (jobStmt) {
        // Effective state changed: commit the upsert and the job in one batch so
        // the outbox row is atomic with the status write it fans out from.
        await db.batch([upsertStmt, jobStmt]);
        return;
      }
    }
  }

  await upsertStmt.run();
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
    /** Extractor version this profile was parsed at; passed so the next sync reuses it. */
    profileExtractVersion: number;
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
         anchor_url = ?, anchor_hash = ?, anchor_status = ?,
         profile_extract_version = ?, last_synced_at = ?
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
      args.profileExtractVersion,
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

/** DRep ids with any registration/metadata date still missing (backfill queue). */
export async function listDrepIdsMissingRegisteredEpoch(db: D1Database): Promise<string[]> {
  const rows = (
    await db
      .prepare(
        'SELECT drep_id FROM dreps WHERE registered_epoch IS NULL OR registered_at IS NULL OR metadata_last_updated_at IS NULL',
      )
      .all<{ drep_id: string }>()
  ).results ?? [];
  return rows.map((r) => r.drep_id);
}

/**
 * Sets the registration/metadata dates for the given DReps in one batch, each
 * column only where it is still NULL (idempotent; never overwrites an already
 * resolved value). Returns the number of statements issued. No-op for an empty
 * list.
 */
export async function setRegistrationDates(
  db: D1Database,
  entries: {
    drepId: string;
    epoch: number | null;
    registeredAt: number | null;
    metadataLastUpdatedAt: number | null;
  }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const stmts = entries.map((e) =>
    db
      .prepare(
        `UPDATE dreps SET
           registered_epoch = COALESCE(registered_epoch, ?),
           registered_at = COALESCE(registered_at, ?),
           metadata_last_updated_at = COALESCE(metadata_last_updated_at, ?)
         WHERE drep_id = ?`,
      )
      .bind(e.epoch, e.registeredAt, e.metadataLastUpdatedAt, e.drepId),
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

/**
 * Points every dreps row that referenced one stored object at another, for the
 * refit pass that rewrites an oversized avatar at display size. Only the hash
 * moves: image_url and image_stored_url still describe the same source. Returns
 * the number of rows moved. The old object is left to the avatar GC, which
 * reaps it once nothing references it anymore.
 */
export async function repointDrepImageHash(
  db: D1Database,
  oldHash: string,
  newHash: string,
): Promise<number> {
  const res = await db
    .prepare('UPDATE dreps SET image_content_hash = ? WHERE image_content_hash = ?')
    .bind(newHash, oldHash)
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

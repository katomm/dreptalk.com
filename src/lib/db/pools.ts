/// <reference types="@cloudflare/workers-types" />
// Read/write access to the pools table: batch identity reads for rendering, the
// on-demand sync work-set, and the avatar work queue. Mirrors src/lib/db/dreps.ts.
import { sqlPlaceholders } from './sql.js';

export interface Pool {
  poolId: string;
  poolHash: string | null;
  ticker: string | null;
  name: string | null;
  homepage: string | null;
  description: string | null;
  imageContentHash: string | null;
  imageStoredUrl: string | null;
}

interface PoolRow {
  pool_id: string;
  pool_hash: string | null;
  ticker: string | null;
  name: string | null;
  homepage: string | null;
  description: string | null;
  image_content_hash: string | null;
  image_stored_url: string | null;
}

function rowToPool(r: PoolRow): Pool {
  return {
    poolId: r.pool_id,
    poolHash: r.pool_hash,
    ticker: r.ticker,
    name: r.name,
    homepage: r.homepage,
    description: r.description,
    imageContentHash: r.image_content_hash,
    imageStoredUrl: r.image_stored_url,
  };
}

// D1 binds at most 100 params per query; chunk the id list well under that.
const ID_CHUNK = 90;

export async function getPoolsByIds(db: D1Database, ids: string[]): Promise<Map<string, Pool>> {
  const result = new Map<string, Pool>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    const rows = (
      await db
        .prepare(
          `SELECT pool_id, pool_hash, ticker, name, homepage, description,
                  image_content_hash, image_stored_url
           FROM pools WHERE pool_id IN (${sqlPlaceholders(chunk)})`,
        )
        .bind(...chunk)
        .all<PoolRow>()
    ).results ?? [];
    for (const row of rows) result.set(row.pool_id, rowToPool(row));
  }
  return result;
}

export interface PoolMetaUpsert {
  poolId: string;
  poolHash: string | null;
  ticker: string | null;
  name: string | null;
  homepage: string | null;
  description: string | null;
  metaUrl: string | null;
  metaHash: string | null;
  imageUrl: string | null;
  syncedAt: number;
}

// Writes metadata for one pool. On conflict it refreshes the metadata fields and
// synced_at; image_url is only overwritten when it changes, and a changed image_url
// clears the stored image so the avatar pass re-fetches it.
export async function upsertPoolMeta(db: D1Database, a: PoolMetaUpsert): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pools
         (pool_id, pool_hash, ticker, name, homepage, description, meta_url, meta_hash, image_url, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pool_id) DO UPDATE SET
         pool_hash   = excluded.pool_hash,
         ticker      = excluded.ticker,
         name        = excluded.name,
         homepage    = excluded.homepage,
         description = excluded.description,
         meta_url    = excluded.meta_url,
         meta_hash   = excluded.meta_hash,
         synced_at   = excluded.synced_at,
         image_url             = COALESCE(excluded.image_url, pools.image_url),
         image_content_hash    = CASE WHEN excluded.image_url IS NOT NULL AND excluded.image_url IS NOT pools.image_url THEN NULL ELSE pools.image_content_hash END,
         image_stored_url      = CASE WHEN excluded.image_url IS NOT NULL AND excluded.image_url IS NOT pools.image_url THEN NULL ELSE pools.image_stored_url END,
         image_fetch_failed_at = CASE WHEN excluded.image_url IS NOT NULL AND excluded.image_url IS NOT pools.image_url THEN NULL ELSE pools.image_fetch_failed_at END,
         image_fetch_attempts  = CASE WHEN excluded.image_url IS NOT NULL AND excluded.image_url IS NOT pools.image_url THEN 0 ELSE pools.image_fetch_attempts END`,
    )
    .bind(
      a.poolId, a.poolHash, a.ticker, a.name, a.homepage, a.description,
      a.metaUrl, a.metaHash, a.imageUrl, a.syncedAt,
    )
    .run();
}

// Active pools (voted as SPO, or an SPO user) that are not yet in pools or whose
// synced_at predates the refresh cutoff. Bounded; the backlog drains over crons.
export async function activePoolIdsNeedingSync(
  db: D1Database,
  limit: number,
  refreshBeforeMs: number,
): Promise<string[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id FROM (
           SELECT DISTINCT voter_id AS id FROM drep_votes WHERE voter_role = 'SPO'
           UNION
           SELECT pool_id AS id FROM users WHERE is_spo = 1 AND pool_id IS NOT NULL
         ) act
         WHERE act.id NOT IN (
           SELECT pool_id FROM pools WHERE synced_at IS NOT NULL AND synced_at >= ?
         )
         LIMIT ?`,
      )
      .bind(refreshBeforeMs, limit)
      .all<{ id: string }>()
  ).results ?? [];
  return rows.map((r) => r.id);
}

export interface PoolAvatarSourceRow {
  poolId: string;
  imageUrl: string;
}

export async function listPoolsNeedingAvatar(
  db: D1Database,
  limit: number,
  maxAttempts: number,
): Promise<PoolAvatarSourceRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT pool_id, image_url FROM pools
         WHERE image_url IS NOT NULL AND image_stored_url IS NULL AND image_fetch_attempts < ?
         ORDER BY image_fetch_attempts ASC, pool_id ASC
         LIMIT ?`,
      )
      .bind(maxAttempts, limit)
      .all<{ pool_id: string; image_url: string }>()
  ).results ?? [];
  return rows.map((r) => ({ poolId: r.pool_id, imageUrl: r.image_url }));
}

export async function setPoolImageStored(
  db: D1Database,
  poolId: string,
  hash: string,
  imageUrl: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pools
       SET image_content_hash = ?, image_stored_url = ?, image_fetch_failed_at = NULL, image_fetch_attempts = 0
       WHERE pool_id = ? AND image_url = ?`,
    )
    .bind(hash, `/api/avatar/${hash}`, poolId, imageUrl)
    .run();
}

export async function markPoolImageFetchFailed(
  db: D1Database,
  poolIds: string[],
  nowMs: number,
): Promise<void> {
  for (let i = 0; i < poolIds.length; i += ID_CHUNK) {
    const chunk = poolIds.slice(i, i + ID_CHUNK);
    if (chunk.length === 0) continue;
    await db
      .prepare(
        `UPDATE pools
         SET image_fetch_failed_at = ?, image_fetch_attempts = image_fetch_attempts + 1
         WHERE pool_id IN (${sqlPlaceholders(chunk)})`,
      )
      .bind(nowMs, ...chunk)
      .run();
  }
}

// Nulls stored-image columns whose source URL disappeared, so the object becomes
// unreferenced and the shared avatar GC can reap it.
export async function clearOrphanedPoolImageStore(db: D1Database): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE pools SET image_content_hash = NULL, image_stored_url = NULL
       WHERE image_url IS NULL AND image_content_hash IS NOT NULL`,
    )
    .run();
  return res.meta.changes ?? 0;
}

export async function listReferencedPoolImageHashes(db: D1Database): Promise<Set<string>> {
  const rows = (
    await db
      .prepare(`SELECT DISTINCT image_content_hash AS h FROM pools WHERE image_content_hash IS NOT NULL`)
      .all<{ h: string }>()
  ).results ?? [];
  return new Set(rows.map((r) => r.h));
}

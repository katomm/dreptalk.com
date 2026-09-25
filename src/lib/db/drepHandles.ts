// D1 access for drep.link handles. A row is live while released_at is NULL or
// later than now. Every read and write here uses that one predicate, so an
// expired row that cleanup has not deleted yet already counts as free.
import { GRACE_SEC } from '../drepLink/handle.js';
import { sqlPlaceholders } from './sql.js';

const LIVE = '(released_at IS NULL OR released_at > ?)';

export interface HandleRow {
  handle: string;
  drepId: string;
  source: 'seed' | 'auto' | 'claim' | 'manual';
  isPrimary: boolean;
  releasedAt: number | null;
  createdAt: number;
}

interface HandleDbRow {
  handle: string;
  drep_id: string;
  source: HandleRow['source'];
  is_primary: number;
  released_at: number | null;
  created_at: number;
}

const toRow = (r: HandleDbRow): HandleRow => ({
  handle: r.handle,
  drepId: r.drep_id,
  source: r.source,
  isPrimary: r.is_primary === 1,
  releasedAt: r.released_at,
  createdAt: r.created_at,
});

/** True once the reviewed launch seed has written its marker row. */
export async function isSeeded(db: D1Database): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS x FROM drep_handle_seed WHERE id = 1').first()) !== null;
}

/** The DRep a live handle points at, with its profile slug when it has one. */
export async function resolveHandle(
  db: D1Database,
  handle: string,
  now: number,
): Promise<{ drepId: string; slug: string | null } | null> {
  const r = await db
    .prepare(
      `SELECT h.drep_id, d.slug FROM drep_handles h LEFT JOIN dreps d ON d.drep_id = h.drep_id
       WHERE h.handle = ? AND (h.released_at IS NULL OR h.released_at > ?)`,
    )
    .bind(handle, now)
    .first<{ drep_id: string; slug: string | null }>();
  return r ? { drepId: r.drep_id, slug: r.slug ?? null } : null;
}

/** Live rows of one DRep, primary first, then previous handles by release time. */
export async function listDrepHandles(db: D1Database, drepId: string, now: number): Promise<HandleRow[]> {
  const rows =
    (
      await db
        .prepare(
          `SELECT handle, drep_id, source, is_primary, released_at, created_at FROM drep_handles
           WHERE drep_id = ? AND ${LIVE} ORDER BY is_primary DESC, released_at DESC`,
        )
        .bind(drepId, now)
        .all<HandleDbRow>()
    ).results ?? [];
  return rows.map(toRow);
}

export async function getPrimaryHandle(db: D1Database, drepId: string, now: number): Promise<string | null> {
  const r = await db
    .prepare(`SELECT handle FROM drep_handles WHERE drep_id = ? AND is_primary = 1 AND ${LIVE}`)
    .bind(drepId, now)
    .first<{ handle: string }>();
  return r?.handle ?? null;
}

export type ClaimOutcome = { ok: true } | { ok: false; error: 'taken' | 'stale' };

/**
 * One transactional batch: drop the DRep's own expired rows, free the target if
 * it is expired or the DRep's own previous handle, demote the expected current
 * primary into grace, insert the new primary. expectedCurrent must be the
 * primary the caller read from D1 for its policy check, never a client value.
 * A plain INSERT fails on a live foreign handle (primary key, so 'taken') or on
 * a concurrent change that already replaced the primary (unique primary index,
 * so 'stale'). Either failure rolls the whole batch back.
 */
export async function writeClaim(
  db: D1Database,
  a: { drepId: string; handle: string; expectedCurrent: string | null; now: number },
): Promise<ClaimOutcome> {
  const { drepId, handle, expectedCurrent, now } = a;
  const stmts = [
    // Own expired rows would still trip the one-primary index before cleanup.
    db
      .prepare('DELETE FROM drep_handles WHERE drep_id = ? AND released_at IS NOT NULL AND released_at <= ?')
      .bind(drepId, now),
    db
      .prepare(
        `DELETE FROM drep_handles WHERE handle = ?
           AND ((released_at IS NOT NULL AND released_at <= ?) OR (drep_id = ? AND is_primary = 0))`,
      )
      .bind(handle, now, drepId),
  ];
  if (expectedCurrent !== null) {
    stmts.push(
      db
        .prepare(
          `UPDATE drep_handles SET is_primary = 0, released_at = ?, updated_at = ?
           WHERE drep_id = ? AND is_primary = 1 AND handle = ?`,
        )
        .bind(now + GRACE_SEC, now, drepId, expectedCurrent),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO drep_handles (handle, drep_id, source, is_primary, released_at, created_at, updated_at)
         VALUES (?, ?, 'claim', 1, NULL, ?, ?)`,
      )
      .bind(handle, drepId, now, now),
  );
  try {
    await db.batch(stmts);
    return { ok: true };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes('drep_handles.handle')) return { ok: false, error: 'taken' };
    if (msg.includes('drep_handles.drep_id')) return { ok: false, error: 'stale' };
    throw err;
  }
}

/**
 * Registered, named DReps the automatic path has not decided on yet. Rows
 * without a registration time wait, so ordering never rests on a missing date.
 * hasHandle marks DReps that claimed a handle before the auto path saw them.
 */
export async function listAutoCandidates(
  db: D1Database,
): Promise<{ drepId: string; name: string | null; registeredAt: number | null; hasHandle: boolean }[]> {
  const rows =
    (
      await db
        .prepare(
          `SELECT d.drep_id, d.name, d.registered_at,
                  EXISTS (SELECT 1 FROM drep_handles h WHERE h.drep_id = d.drep_id) AS has_handle
           FROM dreps d
           WHERE d.handle_auto_at IS NULL AND d.name IS NOT NULL AND d.status = 'registered'
             AND d.registered_at IS NOT NULL
           ORDER BY d.registered_at, d.drep_id`,
        )
        .all<{ drep_id: string; name: string | null; registered_at: number | null; has_handle: number }>()
    ).results ?? [];
  return rows.map((r) => ({
    drepId: r.drep_id,
    name: r.name,
    registeredAt: r.registered_at,
    hasHandle: r.has_handle === 1,
  }));
}

// 99 binds max per statement here: the handles plus `now`.
const LIVE_CHUNK = 98;

/** Handles among `handles` that are live right now (the taken set for the auto path). */
export async function listLiveHandles(db: D1Database, handles: string[], now: number): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < handles.length; i += LIVE_CHUNK) {
    const chunk = handles.slice(i, i + LIVE_CHUNK);
    const rows =
      (
        await db
          .prepare(`SELECT handle FROM drep_handles WHERE handle IN (${sqlPlaceholders(chunk)}) AND ${LIVE}`)
          .bind(...chunk, now)
          .all<{ handle: string }>()
      ).results ?? [];
    for (const r of rows) out.add(r.handle);
  }
  return out;
}

/**
 * Inserts automatic handles and stamps every decided DRep. Expired rows for the
 * same handles are cleared first. INSERT OR IGNORE skips a handle claimed in the
 * meantime and a DRep that already has a primary. Returns rows inserted.
 */
export async function insertAutoHandles(
  db: D1Database,
  rows: { drepId: string; handle: string }[],
  decided: string[],
  now: number,
): Promise<number> {
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    stmts.push(
      db
        .prepare('DELETE FROM drep_handles WHERE handle = ? AND released_at IS NOT NULL AND released_at <= ?')
        .bind(r.handle, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO drep_handles (handle, drep_id, source, is_primary, released_at, created_at, updated_at)
           VALUES (?, ?, 'auto', 1, NULL, ?, ?)`,
        )
        .bind(r.handle, r.drepId, now, now),
    );
  }
  for (const id of decided) {
    stmts.push(db.prepare('UPDATE dreps SET handle_auto_at = ? WHERE drep_id = ?').bind(now, id));
  }
  if (stmts.length === 0) return 0;
  const results = await db.batch(stmts);
  let inserted = 0;
  for (let i = 1; i < rows.length * 2; i += 2) inserted += results[i].meta.changes ?? 0;
  return inserted;
}

/** Grace on deregistration, restore on re-registration, delete expired rows. */
export async function runHandleLifecycle(
  db: D1Database,
  now: number,
): Promise<{ released: number; restored: number; deleted: number }> {
  const [released, restored, deleted] = await db.batch([
    db
      .prepare(
        `UPDATE drep_handles SET released_at = ?, updated_at = ?
         WHERE released_at IS NULL AND drep_id IN (SELECT drep_id FROM dreps WHERE status != 'registered')`,
      )
      .bind(now + GRACE_SEC, now),
    db
      .prepare(
        `UPDATE drep_handles SET released_at = NULL, updated_at = ?
         WHERE is_primary = 1 AND released_at IS NOT NULL AND released_at > ?
           AND drep_id IN (SELECT drep_id FROM dreps WHERE status = 'registered')`,
      )
      .bind(now, now),
    db.prepare('DELETE FROM drep_handles WHERE released_at IS NOT NULL AND released_at <= ?').bind(now),
  ]);
  return {
    released: released.meta.changes ?? 0,
    restored: restored.meta.changes ?? 0,
    deleted: deleted.meta.changes ?? 0,
  };
}

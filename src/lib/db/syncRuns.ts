/// <reference types="@cloudflare/workers-types" />
// Run-level bookkeeping for the gov-sync cron worker (sync_runs table).
// One row per scheduled run; the worker inserts it at start and finalizes it
// at the end, so a row stuck in 'running' is evidence of a killed invocation.
// Parameterized SQL only.

export type SyncRunStatus = 'running' | 'ok' | 'partial' | 'error' | 'killed';

// A run still marked 'running' this long after it started was hard-killed by the
// runtime before it could finalize (real runs finish in well under this). The
// reaper finalizes such orphans as 'killed' so the status page shows a clean
// terminal state instead of an ambiguous, forever-'running' row.
export const STALE_RUN_MS = 15 * 60 * 1000;

export interface SyncPhaseOutcome {
  phase: string;
  ok: boolean;
  /** Wall time the phase took, in ms. */
  ms: number;
  items: number;
  failed: number;
  error?: string;
}

export interface SyncRun {
  id: number;
  kind: string;
  startedAt: number;
  finishedAt: number | null;
  status: SyncRunStatus;
  items: number;
  failed: number;
  error: string | null;
  phases: SyncPhaseOutcome[];
}

interface Row {
  id: number;
  kind: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  items: number;
  failed: number;
  error: string | null;
  phases: string | null;
}

function fromRow(r: Row): SyncRun {
  let phases: SyncPhaseOutcome[] = [];
  try {
    phases = r.phases ? (JSON.parse(r.phases) as SyncPhaseOutcome[]) : [];
  } catch {
    // A malformed phases blob must not break the status page; show no phases.
  }
  return {
    id: r.id,
    kind: r.kind,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as SyncRunStatus,
    items: r.items,
    failed: r.failed,
    error: r.error,
    phases,
  };
}

/** Inserts a 'running' row for a starting run and returns its id. */
export async function startSyncRun(db: D1Database, kind: string, startedAt: number): Promise<number> {
  const res = await db
    .prepare(`INSERT INTO sync_runs (kind, started_at, status) VALUES (?, ?, 'running')`)
    .bind(kind, startedAt)
    .run();
  return res.meta.last_row_id;
}

export interface FinishSyncRun {
  status: SyncRunStatus;
  items: number;
  failed: number;
  error: string | null;
  phases: SyncPhaseOutcome[];
  finishedAt: number;
  /** When set, prune rows older than this in the same D1 batch (one round trip). */
  pruneOlderThanMs?: number;
}

/** Finalizes a run row with its outcome and per-phase details. */
export async function finishSyncRun(db: D1Database, id: number, fin: FinishSyncRun): Promise<void> {
  const update = db
    .prepare(
      `UPDATE sync_runs
         SET finished_at = ?, status = ?, items = ?, failed = ?, error = ?, phases = ?
       WHERE id = ?`,
    )
    .bind(fin.finishedAt, fin.status, fin.items, fin.failed, fin.error, JSON.stringify(fin.phases), id);
  if (fin.pruneOlderThanMs == null) {
    await update.run();
    return;
  }
  await db.batch([
    update,
    db.prepare(`DELETE FROM sync_runs WHERE started_at < ?`).bind(fin.pruneOlderThanMs),
  ]);
}

/** Most recent runs first, across all kinds. */
export async function listSyncRuns(db: D1Database, limit: number): Promise<SyncRun[]> {
  const res = await db
    .prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT ?`)
    .bind(limit)
    .all<Row>();
  return res.results.map(fromRow);
}

/**
 * The single most recent run for each kind, regardless of how many runs other
 * kinds have logged since. The status page uses this for its per-kind "last run"
 * cards: a frequent cron (votes every 20 min) would otherwise push a rare one's
 * run (dreps every 6 h) out of any fixed-size recent-runs window, making the card
 * read "no runs yet" while the sync is in fact healthy. id is autoincrement, so
 * MAX(id) per kind is the latest-started run for that kind.
 */
export async function latestSyncRunByKind(db: D1Database): Promise<SyncRun[]> {
  const res = await db
    .prepare(`SELECT * FROM sync_runs WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY kind)`)
    .all<Row>();
  return res.results.map(fromRow);
}

/** Deletes run rows older than the cutoff; returns how many were removed. */
export async function pruneSyncRuns(db: D1Database, olderThanMs: number): Promise<number> {
  const res = await db.prepare(`DELETE FROM sync_runs WHERE started_at < ?`).bind(olderThanMs).run();
  return res.meta.changes ?? 0;
}

/**
 * Finalizes orphaned runs: any row still 'running' but older than STALE_RUN_MS
 * was killed mid-flight before it could record an outcome, so mark it 'killed'
 * with a finish time. Returns how many were reaped. Idempotent and safe to call
 * at the start of every run; if a reaped run somehow does finish later, its own
 * finishSyncRun overwrites the status.
 */
export async function reapStaleSyncRuns(db: D1Database, nowMs: number): Promise<number> {
  const res = await db
    .prepare(`UPDATE sync_runs SET status = 'killed', finished_at = ? WHERE status = 'running' AND started_at < ?`)
    .bind(nowMs, nowMs - STALE_RUN_MS)
    .run();
  return res.meta.changes ?? 0;
}

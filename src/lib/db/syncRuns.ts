/// <reference types="@cloudflare/workers-types" />
// Run-level bookkeeping for the gov-sync cron worker (sync_runs table).
// One row per scheduled run; the worker inserts it at start and finalizes it
// at the end, so a row stuck in 'running' is evidence of a killed invocation.
// Parameterized SQL only.

export type SyncRunStatus = 'running' | 'ok' | 'partial' | 'error';

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

/** Deletes run rows older than the cutoff; returns how many were removed. */
export async function pruneSyncRuns(db: D1Database, olderThanMs: number): Promise<number> {
  const res = await db.prepare(`DELETE FROM sync_runs WHERE started_at < ?`).bind(olderThanMs).run();
  return res.meta.changes ?? 0;
}

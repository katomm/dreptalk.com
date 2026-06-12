/// <reference types="@cloudflare/workers-types" />
// Per-run bookkeeping wrapper for the gov-sync cron worker. Wraps one scheduled
// run, executes its phases in isolation (one phase throwing never aborts the
// later phases), and records the outcome in the sync_runs table:
//   ok      every phase succeeded and no items failed
//   partial some phase threw or some items failed
//   error   a phase marked primary threw (the run achieved nothing useful)
// Bookkeeping itself is best-effort: if sync_runs is unavailable (e.g. the
// migration has not been applied yet), the run still executes normally.

import {
  startSyncRun, finishSyncRun,
  type SyncPhaseOutcome, type SyncRunStatus,
} from '../db/syncRuns.js';

// Keep enough history to debug a bad week without growing D1 forever.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Item/failure counts a phase reports; both default to 0 when omitted. */
export interface PhaseResult {
  items?: number;
  failed?: number;
}

export type PhaseFn = (
  name: string,
  fn: () => Promise<PhaseResult>,
  opts?: { primary?: boolean },
) => Promise<void>;

export interface SyncRunSummary {
  status: SyncRunStatus;
  items: number;
  failed: number;
  error: string | null;
  phases: SyncPhaseOutcome[];
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function recordSyncRun(
  db: D1Database,
  kind: string,
  run: (phase: PhaseFn) => Promise<void>,
): Promise<SyncRunSummary> {
  const startedAt = Date.now();

  // Best-effort start marker; a null id means bookkeeping is unavailable.
  let runId: number | null = null;
  try {
    runId = await startSyncRun(db, kind, startedAt);
  } catch (err) {
    console.warn(`[sync-run] bookkeeping unavailable (start):`, err);
  }

  const outcomes: SyncPhaseOutcome[] = [];
  let primaryFailed = false;

  const phase: PhaseFn = async (name, fn, opts) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      outcomes.push({ phase: name, ok: true, ms: Date.now() - t0, items: r.items ?? 0, failed: r.failed ?? 0 });
    } catch (err) {
      outcomes.push({ phase: name, ok: false, ms: Date.now() - t0, items: 0, failed: 0, error: errorMessage(err) });
      if (opts?.primary) primaryFailed = true;
      console.warn(`[${kind}:${name}] phase failed:`, err);
    }
  };

  // The run callback itself only throws on a programming error (phases catch
  // their own failures); record it as a failed primary so the run shows 'error'.
  try {
    await run(phase);
  } catch (err) {
    outcomes.push({ phase: 'run', ok: false, ms: Date.now() - startedAt, items: 0, failed: 0, error: errorMessage(err) });
    primaryFailed = true;
    console.error(`[${kind}] run failed outside a phase:`, err);
  }

  const items = outcomes.reduce((n, o) => n + o.items, 0);
  const failed = outcomes.reduce((n, o) => n + o.failed, 0);
  const anyPhaseFailed = outcomes.some((o) => !o.ok);
  const status: SyncRunStatus = primaryFailed ? 'error' : anyPhaseFailed || failed > 0 ? 'partial' : 'ok';
  const firstError = outcomes.find((o) => o.error)?.error ?? null;

  if (runId != null) {
    try {
      await finishSyncRun(db, runId, {
        status, items, failed, error: firstError, phases: outcomes,
        finishedAt: Date.now(), pruneOlderThanMs: startedAt - RETENTION_MS,
      });
    } catch (err) {
      console.warn(`[sync-run] bookkeeping unavailable (finish):`, err);
    }
  }

  return { status, items, failed, error: firstError, phases: outcomes };
}

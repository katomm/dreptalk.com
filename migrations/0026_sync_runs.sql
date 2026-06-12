-- Run-level bookkeeping for the gov-sync cron worker. One row per scheduled
-- run. status: 'running' (in flight or killed mid-run), 'ok' (all phases
-- succeeded), 'partial' (some phase failed or some items failed), 'error'
-- (the primary phase failed). phases holds a JSON array of per-phase outcomes
-- (name, ok, duration, items, failed, error) for the sync status page.
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  items INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  phases TEXT
);

CREATE INDEX idx_sync_runs_started ON sync_runs (started_at DESC);

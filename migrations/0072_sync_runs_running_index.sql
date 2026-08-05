-- Partial index for reapStaleSyncRuns: the reaper runs at the start of every
-- cron tick and filters on `status = 'running' AND started_at < ?`. The only
-- existing index is on started_at, so the planner scanned every finalized row
-- to find the handful still marked running (>99% of rows are terminal in
-- steady state). A partial index on the tiny in-flight set turns the scan
-- into a bounded lookup.
CREATE INDEX IF NOT EXISTS idx_sync_runs_running
  ON sync_runs (started_at)
  WHERE status = 'running';

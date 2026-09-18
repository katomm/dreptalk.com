-- Retry rotation for the threshold-snapshot and finalized-vote backfills, the
-- clock 0106 gave the voted-power backfill (see backfillRotation). Unix ms of each
-- backfill's last attempt at an action, NULL when never attempted.
-- A later redrain (votes_synced_at reset to NULL, or a THRESHOLD_SNAPSHOT_VERSION
-- bump) should clear the matching column too, or rows attempted in the last
-- window wait out the rest of it.
ALTER TABLE governance_actions ADD COLUMN thresholds_attempted_at INTEGER;
ALTER TABLE governance_actions ADD COLUMN votes_backfill_attempted_at INTEGER;

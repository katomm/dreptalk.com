-- Per-DRep voting history queries (WHERE voter_id = ?) and the votes_cast count
-- would otherwise scan the largest table; this index serves both.
CREATE INDEX IF NOT EXISTS idx_drep_votes_voter ON drep_votes(voter_id);

-- Marks an action whose full per-voter vote list has been pulled. Set by the
-- active vote sync and by the finalised-vote backfill. The backfill targets
-- finalised actions where this is NULL, so it terminates cleanly.
ALTER TABLE governance_actions ADD COLUMN votes_synced_at INTEGER;

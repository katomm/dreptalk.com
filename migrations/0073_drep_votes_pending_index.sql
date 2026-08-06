-- Partial index for markStalePendingVotesFailed: reconcilePendingVotes runs on
-- every vote-cron tick and scans drep_votes to find optimistic votes that never
-- landed on chain. Only a handful of rows ever sit in local_status='pending' at
-- any moment (they either clear within seconds via the authoritative sync or age
-- out and get flipped to 'failed'), so a partial index on that state is tiny
-- and turns the scan into a direct lookup.
CREATE INDEX IF NOT EXISTS idx_drep_votes_pending
  ON drep_votes (synced_at)
  WHERE local_status = 'pending';

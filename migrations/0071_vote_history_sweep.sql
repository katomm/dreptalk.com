-- Marks a governance action whose full on-chain vote history has been swept
-- from Koios /vote_list into drep_vote_history (one-time backfill of re-votes
-- cast before live change-tracking existed). NULL = still queued; the gov-sync
-- cron drains the queue a few actions per run, live capture handles everything
-- observed after the sweep.
ALTER TABLE governance_actions ADD COLUMN vote_history_swept_at INTEGER;

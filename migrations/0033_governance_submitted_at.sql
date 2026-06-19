-- Exact on-chain submission time per governance action, in unix ms. Koios
-- proposal_list returns block_time (unix seconds) for every proposal, so
-- discovery stores it (block_time * 1000) and the cron backfills existing rows
-- from the same already-fetched list. submitted_epoch is only 5-day granular, so
-- the "new" sort tie-broke same-epoch actions by a random topic id; submitted_at
-- gives the true newest-first order. Nullable: backfilled asynchronously, and the
-- sort falls back to submitted_epoch while a row is still null.
ALTER TABLE governance_actions ADD COLUMN submitted_at INTEGER;

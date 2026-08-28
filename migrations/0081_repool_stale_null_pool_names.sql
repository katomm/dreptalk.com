-- migrations/0081_repool_stale_null_pool_names.sql
-- Pools whose identity never resolved get re-synced on the next cron run.
-- Their name and ticker were written as null because the upstream source had
-- not resolved (or momentarily lost) the off-chain document, and the 14 day
-- refresh window would keep the blank rows around for up to two weeks. Clearing
-- synced_at puts them back into the work-set, which is bounded per run and
-- drains over a few crons, and the sync now reads the identity out of the
-- off-chain document itself.
UPDATE pools
SET synced_at = NULL
WHERE name IS NULL AND meta_url IS NOT NULL;

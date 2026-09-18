-- Retry rotation for the voted-power backfill.
-- voted_power_attempted_at: unix ms of the backfill's last attempt at an action,
--   whether Koios answered or not, NULL when never attempted. The backfill skips
--   an action attempted within its retry window and orders never-attempted rows
--   first, so an action whose voting summary Koios cannot serve (a request that
--   times out on every tick) is retried rarely and cannot starve the rest of the
--   candidate set.
ALTER TABLE governance_actions ADD COLUMN voted_power_attempted_at INTEGER;

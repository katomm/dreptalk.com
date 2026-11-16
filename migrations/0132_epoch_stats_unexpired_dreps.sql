-- Per-epoch size and voting power of the group behind the header numbers of
-- the DRep list ("Active DReps", "Total voting power"): registered DReps
-- whose activity has not expired under the chain's drep_activity rule (Koios
-- drep_info.active, stored as dreps.active), the predefined options excluded.
-- The columns say "unexpired" on purpose, the table already carries the other
-- meaning of "active" as recently_voting_drep_count.
--
-- The DRep sync recomputes the current epoch's values on every run from the
-- dreps table, so the value that stays is the state at the last DRep sync of
-- the epoch. That is a different instant than the boundary snapshot behind
-- total_drep_power and powered_drep_count in the same row.
--
-- dreps.active is never historised, so the sync can only observe the group
-- going forward: it leaves every row written before this migration NULL, and
-- every row its backfill inserts for a past epoch. A NULL means "no value for
-- this epoch", never zero. Charts start at the first non-NULL row. The
-- binding definitions live in src/lib/analytics/epochStatsContract.ts.

-- unexpired DReps, DReps without voting power included
ALTER TABLE governance_epoch_stats ADD COLUMN unexpired_drep_count INTEGER;
-- the subset holding voting power above zero
ALTER TABLE governance_epoch_stats ADD COLUMN unexpired_powered_drep_count INTEGER;
-- lovelace, summed over the unexpired DReps
ALTER TABLE governance_epoch_stats ADD COLUMN unexpired_drep_power TEXT;
-- share of unexpired_drep_power held by its ten largest DReps
ALTER TABLE governance_epoch_stats ADD COLUMN unexpired_top10_share_pct REAL;

-- Delegator count joins the per-epoch voting power history window: stamped once
-- per epoch from the counts the DRep sync actually observed from Koios that run
-- (see stampDelegatorCounts), so the DRep stats digest can read epoch-over-epoch
-- deltas and a later profile chart extension has a series to draw. NULL for
-- epochs captured before this shipped: Koios has no historical count endpoint,
-- so no backfill is possible.
ALTER TABLE drep_voting_power_history ADD COLUMN delegator_count INTEGER;

-- The stamp scan and the digest candidate join filter by epoch alone, which the
-- (drep_id, epoch) primary key serves poorly. Also covers getStoredEpochs and
-- the window prune.
CREATE INDEX idx_drep_voting_power_history_epoch
  ON drep_voting_power_history(epoch);

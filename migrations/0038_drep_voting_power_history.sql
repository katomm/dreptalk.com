-- Per-epoch DRep voting power snapshots: source for the list delta chip (gain or
-- loss versus the previous epoch) and the profile sparkline. Backfilled from
-- Koios /drep_voting_power_history as a rolling window of the most recent epochs;
-- the sync prunes older rows so the table stays bounded.
CREATE TABLE drep_voting_power_history (
  drep_id TEXT NOT NULL,
  epoch   INTEGER NOT NULL,
  amount  TEXT NOT NULL,
  PRIMARY KEY (drep_id, epoch)
);

-- Latest snapshot (epoch N) and the one before it (epoch N-1), projected from the
-- history table on every sync so the directory list renders the delta from a
-- single fast read with no join. NULL until the first history sync fills them; a
-- NULL prev means no previous-epoch snapshot, so the row shows no delta chip.
ALTER TABLE dreps ADD COLUMN voting_power_snapshot TEXT;
ALTER TABLE dreps ADD COLUMN voting_power_prev TEXT;
ALTER TABLE dreps ADD COLUMN voting_power_snapshot_epoch INTEGER;

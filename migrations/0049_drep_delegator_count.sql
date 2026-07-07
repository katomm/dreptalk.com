-- Delegator headcount per DRep: the number of stake keys whose current vote
-- delegation points at this DRep. Owned by the delegator-count sync phase, not
-- the profile upsert; NULL until first counted. delegator_count_synced_at is the
-- unix-ms timestamp of the last successful count, driving stalest-first refresh.
ALTER TABLE dreps ADD COLUMN delegator_count INTEGER;
ALTER TABLE dreps ADD COLUMN delegator_count_synced_at INTEGER;

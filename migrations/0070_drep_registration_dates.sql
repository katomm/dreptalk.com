-- Exact chain dates for the profile's on-chain details: start of the current
-- registration period and the newest on-chain metadata update. Unix seconds
-- (block_time convention). Filled by the extended registered-epoch backfill,
-- and metadata_last_updated_at is stamped by the DRep sync when it observes an
-- anchor change on an already-known DRep.
ALTER TABLE dreps ADD COLUMN registered_at INTEGER;
ALTER TABLE dreps ADD COLUMN metadata_last_updated_at INTEGER;

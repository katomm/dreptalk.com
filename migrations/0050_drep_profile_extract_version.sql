-- Version of the CIP-119 profile extractor that last wrote each DRep row.
-- The sync reuses a stored profile without re-fetching its anchor only when the
-- row was extracted at the current PROFILE_EXTRACT_VERSION; a bump forces a
-- one-time re-fetch and re-extract, bounded by the per-run anchor budget.
-- Existing rows default to 0 so the first sync after a bump re-extracts them.
ALTER TABLE dreps ADD COLUMN profile_extract_version INTEGER NOT NULL DEFAULT 0;

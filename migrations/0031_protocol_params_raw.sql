-- Full epoch_params response (JSON) cached alongside the extracted thresholds,
-- so the Overview can show old to new for changed protocol parameters without a
-- second Koios call. One row, id = 1; nullable until first refreshed.
ALTER TABLE protocol_params ADD COLUMN raw_json TEXT;

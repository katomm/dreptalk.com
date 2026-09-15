-- Tessera reports `incomplete` on a list or delta when the scan behind it
-- could not read every matching record, so what it served is a prefix of
-- on-chain state rather than the whole of it. The mirror applied such an
-- answer like any other and the freshness line then claimed a snapshot that
-- was current but short. The flag rides with `tessera_fetched_at`, and is
-- written only by a run that advances it, so the two always describe the same
-- snapshot. Existing rows default to complete, which is what every answer so
-- far has reported.
ALTER TABLE survey_sync_state ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0;

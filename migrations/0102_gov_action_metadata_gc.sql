-- Columns the pin garbage collector needs on the InfoAction metadata store.
--
-- pinata_file_id: Pinata's own file handle, which its delete endpoint takes.
--   NULL means "not ours to delete" and covers three cases: a row written
--   before this migration, an upload Pinata deduplicated onto a file that may
--   belong to another project on the shared account, and an upload whose
--   response carried no id. All three must stay out of the collector's reach.
-- last_served_at: when the document was last handed to a submitter, set on
--   insert AND on every dedup hit. The grace period runs from this, not from
--   created_at, so resubmitting an old draft cannot lose the pin it was just
--   given.
-- deleting_at: set while a delete is in flight, so the dedup path refuses to
--   hand out a CID that is about to disappear. Cleared when a delete fails.
-- delete_attempts: lets a permanently failing row fall out of the selection
--   instead of blocking the queue behind it forever.
ALTER TABLE gov_action_metadata ADD COLUMN pinata_file_id TEXT;
ALTER TABLE gov_action_metadata ADD COLUMN last_served_at INTEGER;
ALTER TABLE gov_action_metadata ADD COLUMN deleting_at INTEGER;
ALTER TABLE gov_action_metadata ADD COLUMN delete_attempts INTEGER NOT NULL DEFAULT 0;

-- Existing rows predate the column and have no id, so they are never
-- collectable; giving them a clock anyway keeps the selection predicate simple.
UPDATE gov_action_metadata SET last_served_at = created_at WHERE last_served_at IS NULL;

-- The collector's selection scans on the grace cutoff, so keep it cheap.
CREATE INDEX idx_gov_action_metadata_collectable
  ON gov_action_metadata(last_served_at)
  WHERE pinata_file_id IS NOT NULL;

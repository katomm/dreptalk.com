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
-- deleting_at: a LEASE held while a delete is in flight, so the dedup path
--   refuses to hand out a CID that is about to disappear. Read as a timestamp,
--   not a flag: a run killed mid-flight would otherwise strand the row forever,
--   never served and never re-selected, so a claim older than the staleness
--   cutoff is taken back (the same reasoning runRecorder applies to sync runs).
-- delete_attempts: orders the queue so a row that keeps failing drifts to the
--   back instead of blocking the rows behind it. Deliberately NOT a cutoff: a
--   couple of hours of Pinata being down would otherwise retire rows for good.
ALTER TABLE gov_action_metadata ADD COLUMN pinata_file_id TEXT;
ALTER TABLE gov_action_metadata ADD COLUMN last_served_at INTEGER;
ALTER TABLE gov_action_metadata ADD COLUMN deleting_at INTEGER;
ALTER TABLE gov_action_metadata ADD COLUMN delete_attempts INTEGER NOT NULL DEFAULT 0;

-- Existing rows predate the column and have no id, so they are never
-- collectable. Backfilled anyway so every row reads sensibly, not because any
-- query needs it.
UPDATE gov_action_metadata SET last_served_at = created_at WHERE last_served_at IS NULL;

-- Leads on the ORDER BY columns, not on the filter: with last_served_at first,
-- SQLite read every collectable row into a temp B-tree to sort it before the
-- LIMIT could apply (measured with EXPLAIN QUERY PLAN). This way the LIMIT
-- short-circuits.
CREATE INDEX idx_gov_action_metadata_collectable
  ON gov_action_metadata(delete_attempts, last_served_at)
  WHERE pinata_file_id IS NOT NULL;

-- The collector asks "is this hash anchored" on every pass, and anchor_hash had
-- no index, so that was a full scan of governance_actions. Covering, so the
-- lookup never touches the table.
CREATE INDEX IF NOT EXISTS idx_governance_actions_anchor_hash
  ON governance_actions(anchor_hash);

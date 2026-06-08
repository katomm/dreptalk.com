-- Tracks which metadata-extraction version produced an action's stored
-- title/abstract/rationale_html. Bumped when extraction logic changes so a
-- backfill can re-fetch the anchor and re-extract only the stale rows. Existing
-- rows default to 0 (pre-fix) and get re-extracted; new rows are written current.
ALTER TABLE governance_actions ADD COLUMN meta_version INTEGER NOT NULL DEFAULT 0;

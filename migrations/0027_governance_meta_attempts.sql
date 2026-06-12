-- Counts how many times the metadata re-extract backfill has failed to fetch or
-- verify an action's anchor. The backfill gives up on a row once this reaches
-- META_REEXTRACT_MAX_ATTEMPTS, so a permanently dead or hash-mismatched anchor
-- stops being retried every run (which otherwise pins the governance sync at
-- 'partial' forever and wastes an anchor fetch per cron tick). Reset to 0 by a
-- successful extract; existing rows start at 0 and get the normal retry budget.
ALTER TABLE governance_actions ADD COLUMN meta_attempts INTEGER NOT NULL DEFAULT 0;

-- migrations/0116_delegation_digest.sql
-- Delegator epoch digest (notifications cron). One summary row per followed
-- DRep and completed epoch, and one row per epoch that marks it built and,
-- once every follower has a digest, done. Both are written by one atomic
-- batch per epoch and pruned to the last two epochs by that batch. They hold
-- public on-chain facts about DReps only, no personal data.
CREATE TABLE delegation_digest_dreps (
  epoch      INTEGER NOT NULL,
  drep_id    TEXT NOT NULL,
  payload    TEXT NOT NULL,
  reportable INTEGER NOT NULL,
  PRIMARY KEY (epoch, drep_id)
);

CREATE TABLE delegation_digest_epochs (
  epoch    INTEGER PRIMARY KEY,
  built_at INTEGER NOT NULL, -- unix ms, database clock
  done_at  INTEGER           -- unix ms, database clock, NULL while followers are left
);

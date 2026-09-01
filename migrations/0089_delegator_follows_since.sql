-- Delegation start capture per tracked delegator. The epoch of the newest
-- delegation_drep event on the account, so a delegator page can scope "since I
-- delegated" without re-querying Koios on every view.
-- All three columns are outside the 0063 CHECK constraint on purpose: the start
-- is captured independently of resolution_status, and a pending row may already
-- carry recorded attempts.
ALTER TABLE delegator_follows ADD COLUMN delegated_since_epoch INTEGER;   -- NULL until captured
ALTER TABLE delegator_follows ADD COLUMN since_checked_at INTEGER;        -- unix seconds of the last capture attempt
-- Capture attempts that ended without a start. Reset to 0 by a successful
-- capture and by a delegation change, so the page can tell "not looked up yet"
-- from "looked for repeatedly and not found".
ALTER TABLE delegator_follows ADD COLUMN since_attempts INTEGER NOT NULL DEFAULT 0;

-- Bulk capture scan: rows still missing a start, stalest attempt first.
CREATE INDEX idx_delegator_follows_since_checked
  ON delegator_follows(since_checked_at)
  WHERE delegated_since_epoch IS NULL;

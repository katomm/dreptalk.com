-- Delegation start capture per tracked delegator. The epoch of the newest
-- delegation_drep event on the account, so a delegator page can scope "since I
-- delegated" without re-querying Koios on every view.
-- Both columns are outside the 0063 CHECK constraint on purpose: the start is
-- captured independently of resolution_status, and a pending row may already
-- carry a recorded attempt.
ALTER TABLE delegator_follows ADD COLUMN delegated_since_epoch INTEGER;   -- NULL until captured
ALTER TABLE delegator_follows ADD COLUMN since_checked_at INTEGER;        -- unix seconds of the last capture attempt

-- Bulk capture scan: rows still missing a start, stalest attempt first.
CREATE INDEX idx_delegator_follows_since_checked
  ON delegator_follows(since_checked_at)
  WHERE delegated_since_epoch IS NULL;

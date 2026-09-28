-- What the wallet just delegated to, recorded by the delegation dialog before
-- the chain reports it. Two jobs: the dashboard shows the pending target
-- instead of the stale one, and no change notification is written while the
-- expectation is live, so nobody is told about their own delegation. Cleared by
-- expiry only (EXPECTED_TTL_SEC), never by a confirmation, so a Koios replica
-- reporting the old value again stays quiet too. No index: the row is always
-- read by primary key.
ALTER TABLE delegator_follows ADD COLUMN expected_drep_id TEXT;
ALTER TABLE delegator_follows ADD COLUMN expected_at INTEGER;
ALTER TABLE delegator_follows ADD COLUMN expected_tx TEXT;

-- Coarse origin of an account, written once when the row is created and never
-- updated. One closed vocabulary token, no referrer, no campaign parameters.
ALTER TABLE users ADD COLUMN signup_ref TEXT;

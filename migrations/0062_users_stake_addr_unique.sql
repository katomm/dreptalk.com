-- A stake address identifies at most one account. This is the constraint that
-- actually blocks two users rows sharing a stake address (the per-account
-- "stake_addr IS NULL" guard on the writer-link UPDATE only protects one row).
-- Partial: only non-null stake addresses must be unique.
CREATE UNIQUE INDEX idx_users_stake_addr_unique
  ON users(stake_addr) WHERE stake_addr IS NOT NULL;

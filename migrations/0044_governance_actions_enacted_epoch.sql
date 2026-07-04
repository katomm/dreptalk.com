-- Enactment epoch of a governance action, synced from Koios /proposal_list
-- (enacted_epoch). Needed to attribute enacted TreasuryWithdrawals to the
-- correct Net Change Limit period, which is keyed on when a withdrawal was
-- enacted, not when it was submitted.
ALTER TABLE governance_actions ADD COLUMN enacted_epoch INTEGER;

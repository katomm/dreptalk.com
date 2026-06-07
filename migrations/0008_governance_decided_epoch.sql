-- The epoch of the terminal lifecycle event (enacted / ratified / expired /
-- dropped). Used to sort "recently ratified" governance actions by when they
-- were decided. Null while the action is still active or pending.
ALTER TABLE governance_actions ADD COLUMN decided_epoch INTEGER;

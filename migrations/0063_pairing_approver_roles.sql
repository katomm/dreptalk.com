-- The role cap of the approving session, snapshotted at approval as a JSON
-- array. Redemption grants at most (current account roles INTERSECT this cap).
-- NULL means a legacy pairing approved before this column existed (unbounded,
-- prior behavior); new approvals always write an array, never NULL.
ALTER TABLE device_pairings ADD COLUMN approver_roles TEXT;

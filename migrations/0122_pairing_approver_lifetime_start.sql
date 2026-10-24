-- Start of the approving session's absolute lifetime (Unix seconds),
-- snapshotted at approval. The paired device's session inherits it, so pairing
-- never restarts the lifetime that only a wallet sign-in may start. NULL means
-- a pairing approved before this column existed (the device session starts fresh).
ALTER TABLE device_pairings ADD COLUMN approver_lifetime_start INTEGER;

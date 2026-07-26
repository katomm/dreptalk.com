-- Device pairings: a phone starts one, a signed-in desktop approves it, the
-- phone redeems it for a session. Rows are short lived (10 minutes) and swept
-- on insert, so no cron is needed.
--
-- D1 rather than KV for the same reason auth_nonces uses D1: KV has no
-- compare-and-delete, so a get-check-write would let two concurrent requests
-- both succeed. Approval and redemption are each a single statement with
-- RETURNING, which SQLite serializes.
CREATE TABLE IF NOT EXISTS device_pairings (
  pairing_id   TEXT PRIMARY KEY,      -- opaque locator handed to the device
  code_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 of the normalized code; the code is never stored
  secret_hash  TEXT NOT NULL,         -- SHA-256 of the device secret; authenticator only
  status       TEXT NOT NULL,         -- 'pending' | 'approved' | 'consumed'
  user_id      TEXT,                  -- set on approval; identity only, never authorization
  user_agent   TEXT,                  -- captured at start, shown on the approval screen
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_pairings_expires_at ON device_pairings(expires_at);

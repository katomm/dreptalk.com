-- Single-use login nonces, moved off KV into D1.
--
-- KV has no atomic get-and-delete, so the previous consumeNonce (get, check,
-- delete) had a narrow race where two concurrent verifies carrying the same
-- signed payload could both observe the nonce present and both succeed. In D1
-- the consume is a single DELETE ... RETURNING: SQLite serializes writes, so at
-- most one concurrent request gets a row back. Rows are short-lived (5 min) and
-- swept opportunistically on the next issue.
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires_at ON auth_nonces (expires_at);

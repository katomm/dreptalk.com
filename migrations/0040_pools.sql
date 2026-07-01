-- On-demand stake-pool metadata for pools that appear on the platform (voted on a
-- governance action, or registered as an SPO user). Mirrors the drep avatar columns
-- so the shared R2 avatar store / GC / serve path applies unchanged.
CREATE TABLE pools (
  pool_id               TEXT PRIMARY KEY,   -- bech32 pool1...
  pool_hash             TEXT,               -- hex pool hash, identicon seed
  ticker                TEXT,
  name                  TEXT,
  homepage              TEXT,
  description           TEXT,
  meta_url              TEXT,               -- on-chain off-chain metadata URL
  meta_hash             TEXT,               -- change detection
  image_url             TEXT,               -- resolved logo source URL (from extended metadata)
  image_content_hash    TEXT,               -- sha256 of stored R2 bytes
  image_stored_url      TEXT,               -- R2-served URL
  image_fetch_failed_at INTEGER,            -- unix ms of last failed image fetch
  image_fetch_attempts  INTEGER NOT NULL DEFAULT 0,
  synced_at             INTEGER             -- unix ms of last metadata sync
);

-- Avatar work queue: pools with a logo URL but no stored image yet, fewest attempts first.
CREATE INDEX idx_pools_needing_avatar
  ON pools (image_fetch_attempts)
  WHERE image_url IS NOT NULL AND image_stored_url IS NULL;

-- Constitutional committee membership over time. committee_member holds one row
-- per (cold key, version) with the version's active-epoch window, the member's
-- term expiration, the epoch its hot key was first registered, and the epoch it
-- resigned (null when still active). committee_hot_key maps each hot key to its
-- member, so per-voter votes (cast with hot keys, sometimes rotated) collapse to
-- one vote per member. Together they resolve the ledger-active committee size at
-- any action's decided epoch, the denominator for the committee yes-percentage.
CREATE TABLE committee_member (
  cold_key_hex TEXT NOT NULL,
  version_from INTEGER NOT NULL,      -- first epoch this committee version is active
  version_to INTEGER,                 -- last active epoch, NULL = current version
  term_expiration INTEGER NOT NULL,   -- epoch the term expires (active through it)
  authorized_from INTEGER NOT NULL,   -- first epoch a hot key was registered
  resigned_at INTEGER,                -- epoch the hot key was de-registered, NULL = active
  PRIMARY KEY (cold_key_hex, version_from)
);

CREATE TABLE committee_hot_key (
  hot_key_hex TEXT PRIMARY KEY,
  cold_key_hex TEXT NOT NULL
);

CREATE INDEX idx_committee_member_epochs ON committee_member (version_from, version_to);

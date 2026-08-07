-- Current, self-declared display name for a Constitutional Committee member,
-- sourced from the authors[].name of that member's most recent vote rationale
-- anchor (CIP-100). NOT a verified or canonical identity, and NOT a history:
-- exactly one row per hot key, the newest vote wins. source_block_time exists
-- only to make "newest vote wins" safe under out-of-order async ingest (it is
-- the on-chain vote time, not an ingest time), it is not used for as-of lookups.
-- Keyed by hot key because CC votes are cast (and stored in drep_votes.voter_hex)
-- by hot key, cold keys resolve through committee_hot_key. Hex is lower-case.
CREATE TABLE cc_member_name (
  hot_key_hex       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  source_ga_id      TEXT,             -- provenance only (which action's vote supplied it), not read by the UI
  source_block_time INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

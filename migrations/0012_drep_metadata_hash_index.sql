-- The hosted metadata is served at /drep/{hash}.json (the drep id is not in the
-- anchor url, which is capped at 128 chars by CIP-100). Serving therefore looks
-- the row up by hash alone, which the (drep_id, hash) primary key index cannot
-- satisfy (hash is the second column). Add a dedicated index on hash.
CREATE INDEX idx_drep_metadata_hash ON drep_metadata(hash);

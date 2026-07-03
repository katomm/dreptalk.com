-- On-chain vote rationale ingestion.

-- The vote anchor's blake2b-256 hash (Koios proposal_votes.meta_hash). Required
-- to verify the off-chain rationale document before we render it. NULL when the
-- vote carries no anchor or the hash is unknown.
ALTER TABLE drep_votes ADD COLUMN meta_hash TEXT;

-- Render store for a voter's rationale on one action: one row per (action, voter).
-- Populated by the vote sync (on-chain, above the power threshold) and by the
-- dreptalk self-cast path. body_html is the sanitized, rendered rationale, or NULL
-- when the fetch failed or the document carried no comment.
CREATE TABLE action_rationale (
  ga_id      TEXT NOT NULL,            -- governance action id (tx_hash#index)
  voter_id   TEXT NOT NULL,            -- CIP-129 drep id; matches drep_votes.voter_id
  body_html  TEXT,                     -- sanitized rendered rationale, or NULL
  source     TEXT NOT NULL,            -- 'onchain' | 'dreptalk'
  anchor_url TEXT,                     -- the meta_url fetched (immutable per vote), or NULL for self-cast
  status     TEXT NOT NULL,            -- 'ok' | 'empty' | 'failed'
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,         -- vote block time, milliseconds (display date)
  fetched_at INTEGER NOT NULL,         -- last fetch/upsert attempt, milliseconds
  PRIMARY KEY (ga_id, voter_id)
);

-- Read path: all rationales for one action (Positions tab join).
CREATE INDEX idx_action_rationale_ga ON action_rationale (ga_id);

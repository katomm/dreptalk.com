-- Superseded on-chain votes: when a voter re-votes on an action, the previous
-- drep_votes row is archived here before being replaced, so profiles and the
-- Positions tab can show that (and how) a vote changed. body_html is the
-- rendered rationale snapshot that belonged to the superseded vote.
CREATE TABLE drep_vote_history (
  ga_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  voter_role TEXT NOT NULL,
  vote TEXT NOT NULL,
  meta_url TEXT,
  meta_hash TEXT,
  block_time INTEGER NOT NULL,
  body_html TEXT,
  superseded_at INTEGER NOT NULL,
  PRIMARY KEY (ga_id, voter_id, block_time)
);
-- Profile lookup: all superseded votes of one voter.
CREATE INDEX idx_vote_history_voter ON drep_vote_history(voter_id);

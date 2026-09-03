-- migrations/0091_surveys.sql
-- CIP-179 surveys mirrored from the Tessera serving backend. DRepTalk holds no
-- CIP-179 rule of its own: rows are Tessera's answers written down, refreshed
-- by the gov-sync surveys phase, and every page renders from here (never from
-- Tessera). Admission (which surveys get a row at all) is editorial policy in
-- the sync, not encoded in this schema, so widening it later is one predicate.

-- One row per admitted survey. `ref` is the canonical CIP-179 reference
-- "<txHashHex>:<index>" (lowercase, index without leading zeros) — the same
-- string Tessera keys everything by. A row is written only when one of its
-- values moved, so `synced_at` dates the last change Tessera reported, not the
-- last time the sync looked; the mirror-wide "as of" lives in survey_sync_state.
CREATE TABLE survey (
  ref                TEXT PRIMARY KEY,
  topic_id           TEXT NOT NULL,      -- the survey's forum thread
  title              TEXT NOT NULL,
  end_epoch          INTEGER NOT NULL,   -- inclusive response cutoff (CIP-179)
  eligible_roles     TEXT NOT NULL,      -- JSON array of CIP-179 role ints (DRep = 0)
  sealed             INTEGER NOT NULL DEFAULT 0,
  cancelled          INTEGER NOT NULL DEFAULT 0,
  external_content   INTEGER NOT NULL DEFAULT 0,
  definition         TEXT NOT NULL,      -- wire-form record JSON (cip-179 fromJsonSafe decodes it)
  -- Participation, from two of Tessera's own counts and never from a count of
  -- DRepTalk's own. counted_dreps is the in-window figure: the DRep entry of
  -- the list's per-role audited count, refreshed while the survey is held and
  -- NULL while the backend serves none. final_counted_dreps is the DRep
  -- responder count of the finalized tally artifact, which also applies
  -- end-epoch role membership, so it can be lower than the in-window figure;
  -- NULL until the artifact has been read, and forever on a cancelled or
  -- untalliable survey.
  counted_dreps      INTEGER,
  final_counted_dreps INTEGER,
  -- NULL while the survey can still change; set once Tessera decides it for
  -- good ('finalized' | 'cancelled' | 'untalliable'). A decided row is no
  -- longer refreshed. artifact_hash is the content address of the tally
  -- artifact the decision published (finalized and cancelled carry one), kept
  -- so the final count can be read on a later run when the artifact request
  -- fails on the run the decision arrives.
  final_state        TEXT,
  artifact_hash      TEXT,
  -- The on-chain record disappeared from a complete Tessera answer (rolled
  -- back). Hides answering, keeps the thread; cleared if the ref reappears.
  -- unavailable_since (unix ms) is the rollback exit from the refresh set:
  -- past the sync's TTL the row stops being named in ?refs= calls, since no
  -- final state is ever coming for a record that is gone.
  unavailable        INTEGER NOT NULL DEFAULT 0,
  unavailable_since  INTEGER,
  submitted_at       INTEGER,            -- survey publication time (unix ms, slot-derived)
  synced_at          INTEGER NOT NULL    -- last change written by the sync (unix ms)
);
CREATE INDEX idx_survey_topic ON survey(topic_id);

-- Governance actions advertising a survey (N actions may link one survey).
-- action_id is the bech32 gov_action id, joining governance_actions.proposal_id;
-- title is the action title Tessera extracted from the CIP-108 anchor, kept so
-- the survey card can name a linking action DRepTalk has not imported.
CREATE TABLE survey_gov_link (
  survey_ref TEXT NOT NULL,
  action_id  TEXT NOT NULL,
  title      TEXT,
  PRIMARY KEY (survey_ref, action_id)
);
CREATE INDEX idx_survey_gov_link_action ON survey_gov_link(action_id);

-- Optimistic record of a just-submitted response, mirroring the GA-vote
-- pending lifecycle (drep_votes.local_status): written by the record API right
-- after submit, deleted once the sync sees the exact transaction indexed, aged
-- to 'failed' when it never lands. credential is the responder's CIP-179
-- credential key ("key:<hex>"), derived from the session at record time.
CREATE TABLE survey_response_local (
  survey_ref TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  tx_hash    TEXT NOT NULL,
  credential TEXT NOT NULL,
  status     TEXT NOT NULL,              -- 'pending' | 'failed'
  created_at INTEGER NOT NULL,           -- unix ms
  PRIMARY KEY (survey_ref, user_id)
);

-- Single-row sync state (id = 1, like protocol_params). linked_count is the
-- last seen size of Tessera's linked set (page one re-evaluates the whole set
-- while it fits; a moved count is one of the triggers to walk further) and
-- last_full_walk_at when pass 1 last walked the complete list.
-- tessera_fetched_at is the snapshot time (unix s) of the oldest answer used
-- by the last run that brought every held row up to date — the "as of" every
-- survey page shows. One value for the whole mirror: every held row is
-- refreshed on every run, and a decided row cannot change, so no row is
-- fresher than the mirror.
CREATE TABLE survey_sync_state (
  id                 INTEGER PRIMARY KEY,
  linked_count       INTEGER,
  last_full_walk_at  INTEGER,             -- unix ms
  tessera_fetched_at INTEGER
);

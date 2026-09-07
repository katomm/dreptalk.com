-- migrations/0091_surveys.sql
-- CIP-179 surveys mirrored from the Tessera serving backend. DRepTalk holds no
-- CIP-179 rule of its own: rows are Tessera's answers written down, refreshed
-- by the gov-sync surveys phase, and every page renders from here (never from
-- Tessera). Admission — which surveys get a row, and which of those get a
-- thread — is editorial policy in the sync, not encoded in this schema, so
-- widening it later is one predicate.

-- One row per mirrored survey. `ref` is the canonical CIP-179 reference
-- "<txHashHex>:<index>" (lowercase, index without leading zeros) — the same
-- string Tessera keys everything by. A row is written only when one of its
-- values moved, so `synced_at` dates the last change Tessera reported, not the
-- last time the sync looked; the mirror-wide "as of" lives in survey_sync_state.
CREATE TABLE survey (
  ref                TEXT PRIMARY KEY,
  -- The survey's forum thread, NULL while it has none: the row is Tessera's
  -- answer written down as soon as the survey is eligible, the thread is
  -- opened once a linking action is imported here. Every page reader joins
  -- topics, so a row without one is invisible until then.
  topic_id           TEXT,
  title              TEXT NOT NULL,
  end_epoch          INTEGER NOT NULL,   -- inclusive response cutoff (CIP-179)
  eligible_roles     TEXT NOT NULL,      -- JSON array of CIP-179 role ints (DRep = 0)
  sealed             INTEGER NOT NULL DEFAULT 0,
  cancelled          INTEGER NOT NULL DEFAULT 0,
  external_content   INTEGER NOT NULL DEFAULT 0,
  definition         TEXT NOT NULL,      -- wire-form record JSON (cip-179 decodeSurveyRecord reads it)
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
  -- Tessera no longer lists the survey as eligible: its record is gone, or
  -- it is listed with no link at all — either way a rollback upstream. Only a
  -- published row is flagged (a row with no thread is simply deleted): the
  -- flag hides answering and keeps the thread, and presence in a later
  -- answer clears it. unavailable_since (unix ms) dates the withdrawal for
  -- the page.
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

-- The mirror's bookkeeping, one row. changes_cursor is where Tessera's change
-- selection continues from (opaque, minted by the backend): NULL until the
-- first run's bootstrap — the same selection from instant zero — has been
-- applied to its end, and never expiring after, since the backend keeps its
-- tombstones for the life of the corpus.
-- tessera_fetched_at is the snapshot time (unix s) of the oldest answer used
-- by the last run that brought every held row up to date — the "as of" every
-- survey page shows. One value for the whole mirror: the delta names every
-- held row that moved, and a decided row cannot change, so no row is fresher
-- than the mirror.
CREATE TABLE survey_sync_state (
  id                 INTEGER PRIMARY KEY,
  changes_cursor     TEXT,
  tessera_fetched_at INTEGER
);

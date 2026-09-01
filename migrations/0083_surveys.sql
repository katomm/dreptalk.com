-- migrations/0083_surveys.sql
-- CIP-179 surveys mirrored from the Tessera serving backend. DRepTalk holds no
-- CIP-179 rule of its own: rows are Tessera's answers written down, refreshed
-- by the gov-sync surveys phase, and every page renders from here (never from
-- Tessera). Admission (which surveys get a row at all) is editorial policy in
-- the sync, not encoded in this schema, so widening it later is one predicate.

-- One row per admitted survey. `ref` is the canonical CIP-179 reference
-- "<txHashHex>:<index>" (lowercase, index without leading zeros) — the same
-- string Tessera keys everything by.
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
  -- The number the survey card shows: counted records with role DRep, from
  -- running Tessera's published auditResponses over the survey's bundle.
  -- NULL until the first audit lands.
  counted_dreps      INTEGER,
  -- The list's raw responseCount: unfiltered, summed across roles. Change
  -- detector for re-audits only, never rendered.
  claimed_count      INTEGER NOT NULL DEFAULT 0,
  -- NULL while the survey can still change; set once Tessera decides it for
  -- good ('finalized' | 'cancelled' | 'untalliable'). A non-NULL row is no
  -- longer refreshed — but its count still needs one successful audit at or
  -- after that moment (proof verdicts land late), a debt audit_due_at carries.
  final_state        TEXT,
  -- Audit scheduling, one row at a time. audit_due_at is the only scheduler:
  -- admission, a moved claimed_count, the tip crossing end_epoch and an
  -- arriving final_state all set it to "now"; success on a still-open survey
  -- re-arms it a day out (a verdict can flip without the count moving), and a
  -- failure backs off exponentially. NULL means no audit will ever run again —
  -- for a decided row that is the terminal state, reached by one successful
  -- post-final audit or by giving up, which clears counted_dreps: a decided
  -- row's count is either the audited final count or absent.
  audited_at         INTEGER,            -- last successful audit (unix ms)
  audit_due_at       INTEGER,            -- next attempt due (unix ms)
  audit_attempts     INTEGER NOT NULL DEFAULT 0,  -- consecutive failures
  -- The on-chain record disappeared from a complete Tessera answer (rolled
  -- back). Hides answering, keeps the thread; cleared if the ref reappears.
  unavailable        INTEGER NOT NULL DEFAULT 0,
  tip_epoch          INTEGER NOT NULL,   -- chain tip epoch of the mirrored snapshot
  tessera_fetched_at INTEGER NOT NULL,   -- snapshot time (unix s) — the "as of" the UI shows
  submitted_at       INTEGER,            -- survey publication time (unix ms, slot-derived)
  synced_at          INTEGER NOT NULL    -- last write by the sync (unix ms)
);
CREATE INDEX idx_survey_topic ON survey(topic_id);
CREATE INDEX idx_survey_audit_due ON survey(audit_due_at);

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

-- Single-row sync state (id = 1, like protocol_params): the last seen size of
-- Tessera's linked set (page one re-evaluates the whole set while it fits; a
-- moved count is one of the triggers to walk further) and when pass 1 last
-- walked the complete list.
CREATE TABLE survey_sync_state (
  id                INTEGER PRIMARY KEY,
  linked_count      INTEGER,
  last_full_walk_at INTEGER              -- unix ms
);

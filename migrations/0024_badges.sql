-- Achievement badges. Awards are permanent and monotonic: a row is inserted on
-- first award and its tier only ever increases (0 = untiered single award,
-- 1/2/3 = bronze/silver/gold). Definitions live in config/badges.ts; the
-- awarding engine (src/lib/badges/engine.ts) runs in the gov-sync cron.

-- Unix seconds of the vote tx (Koios proposal_votes.block_time); enables the
-- time-based badges (the vote's epoch is derived at award time).
ALTER TABLE drep_votes ADD COLUMN block_time INTEGER;

-- subject_id per type: drep/spo/cc = the CIP-129 voter id, proposer = the
-- action's return_address, user = users.id.
CREATE TABLE badge_awards (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('drep', 'spo', 'cc', 'proposer', 'user')),
  subject_id   TEXT NOT NULL,
  badge_id     TEXT NOT NULL,
  tier         INTEGER NOT NULL DEFAULT 0,
  awarded_at   INTEGER NOT NULL,
  upgraded_at  INTEGER,
  PRIMARY KEY (subject_type, subject_id, badge_id)
);

-- Holder counts for the /badges overview and rarity ranking of the profile
-- showcase; per-subject reads ride the primary key's leftmost prefix.
CREATE INDEX idx_badge_awards_badge ON badge_awards(badge_id);

-- One-time re-queue (same pattern as 0021 for meta_url): concluded actions were
-- synced before drep_votes.block_time existed, so the finalized-votes backfill
-- re-fetches their voter lists, which now capture it.
UPDATE governance_actions SET votes_synced_at = NULL WHERE status NOT IN ('active', 'pending');

-- Proposal Drafts: an action whose CIP-108 references link a Proposal Drafts
-- thread records that thread here. Several actions may point at one draft
-- (a resubmission), an action points at most at one draft.
ALTER TABLE governance_actions ADD COLUMN draft_topic_id TEXT;
CREATE INDEX IF NOT EXISTS idx_governance_actions_draft_topic ON governance_actions(draft_topic_id);

-- Set when the draft's author (or a moderator) unlinked this action: it never
-- links to any draft again.
ALTER TABLE governance_actions ADD COLUMN draft_link_rejected INTEGER NOT NULL DEFAULT 0;

-- One-time re-queue: votes on governance actions that concluded before migration
-- 0020 were synced without the per-vote rationale anchor (drep_votes.meta_url),
-- so their rationale rate reads as zero. votes_synced_at is the finalized-votes
-- backfill queue marker (getActionsNeedingVoteBackfill picks up terminal actions
-- with votes_synced_at IS NULL). Nulling it for concluded actions makes the
-- backfill re-fetch their per-voter lists, which now capture meta_url. Actions
-- synced after 0020 already carry it and are unaffected going forward.
UPDATE governance_actions SET votes_synced_at = NULL WHERE status NOT IN ('active', 'pending');

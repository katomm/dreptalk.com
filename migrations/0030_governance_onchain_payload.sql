-- Raw Koios proposal_description JSON (the decoded on-chain action body) per
-- governance action. Used to render the per-type "On-chain changes" block.
-- Nullable: backfilled over subsequent cron ticks for pre-existing rows.
ALTER TABLE governance_actions ADD COLUMN onchain_payload TEXT;

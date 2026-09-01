-- Per-action No-side vote power (lovelace) for each body, captured from Koios
-- proposal_voting_summary at tally time: drep_no_vote_power / pool_no_vote_power.
-- This is the ratification No side, so it already folds in the cast No votes, the
-- non-voting default No, AND the always-no-confidence bucket. Verified against
-- Koios across four action types: the reported yes percentage is exactly
-- yes / (yes + no_vote_power), and adding always-no-confidence a second time
-- breaks that identity (65.92 becomes 64.03). Consumers must therefore never sum
-- this column with the always_no_confidence_power columns.
--
-- TEXT for the same reason as 0085: these buckets exceed 2^53 lovelace and an
-- INTEGER read through a JS number would silently round them.
ALTER TABLE governance_actions ADD COLUMN drep_no_side_power TEXT;
ALTER TABLE governance_actions ADD COLUMN spo_no_side_power TEXT;

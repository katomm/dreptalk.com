-- Per-option voting power (lovelace) so the sidebar can show the real stake behind
-- each DRep/SPO vote option, not just the percentage. The existing drep_yes/no/
-- abstain and spo_* columns hold vote COUNTS (number of voters), which is why
-- formatting them as ada rendered "0 ADA"; these power columns hold the stake.
-- DRep uses the clean drep_active_yes/no/abstain_vote_power buckets; SPO uses
-- pool_active_yes_vote_power (yes), pool_no_vote_power (no), and
-- pool_passive_always_abstain_vote_power (abstain). CC has no stake and keeps its
-- member counts. Stored as INTEGER lovelace (same precision trade-off as
-- drep_voted_power).
ALTER TABLE governance_actions ADD COLUMN drep_yes_power INTEGER;
ALTER TABLE governance_actions ADD COLUMN drep_no_power INTEGER;
ALTER TABLE governance_actions ADD COLUMN drep_abstain_power INTEGER;
ALTER TABLE governance_actions ADD COLUMN spo_yes_power INTEGER;
ALTER TABLE governance_actions ADD COLUMN spo_no_power INTEGER;
ALTER TABLE governance_actions ADD COLUMN spo_abstain_power INTEGER;

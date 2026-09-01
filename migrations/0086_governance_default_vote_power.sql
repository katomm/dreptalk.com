-- Per-action vote power of the predefined delegation options, captured from
-- Koios proposal_voting_summary at tally time. TEXT on purpose: the
-- always-abstain bucket exceeds 2^53 lovelace, an INTEGER read through a JS
-- number would silently round it. Consumers treat these as raw lovelace
-- strings (BigInt or display formatting only).
ALTER TABLE governance_actions ADD COLUMN drep_always_abstain_power TEXT;
ALTER TABLE governance_actions ADD COLUMN drep_always_no_confidence_power TEXT;
ALTER TABLE governance_actions ADD COLUMN spo_always_abstain_power TEXT;
ALTER TABLE governance_actions ADD COLUMN spo_always_no_confidence_power TEXT;

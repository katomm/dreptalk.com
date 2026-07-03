-- Eligible SPO voting stake (lovelace) per action: the denominator for SPO turnout.
-- Numerator (active voted) is spo_yes_power + spo_no_power + spo_abstain_power.
ALTER TABLE governance_actions ADD COLUMN spo_eligible_power INTEGER;

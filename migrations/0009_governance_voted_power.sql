-- Active DRep voting power (lovelace) that actually voted on each action, summed
-- from the Koios voting summary (drep_active_yes/no/abstain_vote_power). Lets the
-- overview show stake participation (turnout) for every tallied action, not just
-- active ones with a synced per-voter list. Stored as INTEGER lovelace; the per
-- action sum is well within JS safe-integer range.
ALTER TABLE governance_actions ADD COLUMN drep_voted_power INTEGER;

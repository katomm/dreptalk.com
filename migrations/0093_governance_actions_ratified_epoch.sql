-- The epoch an action was ratified, from Koios proposal_list.ratified_epoch.
-- decided_epoch keeps its existing meaning (the terminal epoch, which becomes
-- the enactment epoch once an action is enacted), so the ratification epoch
-- needs its own column to stay recoverable. NULL until a sync observes it.
ALTER TABLE governance_actions ADD COLUMN ratified_epoch INTEGER;

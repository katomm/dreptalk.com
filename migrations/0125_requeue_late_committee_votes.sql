-- One more per-voter vote pull for the six enacted actions whose vote lists miss
-- a committee vote cast during their tally epoch, after the pull at the first
-- freeze. Nulling votes_synced_at re-queues them for the finalized-vote backfill,
-- which drains them on its own. From now on enactment re-queues this pull itself
-- (updateGovernanceActionStatus). The ids exist on mainnet only, so on preprod
-- this changes nothing.
UPDATE governance_actions SET votes_synced_at = NULL
 WHERE id IN (
   'b3d452bff7769d7f557ec6b8974760ee6c5e496c276652b654032966621e0ccf#1',
   'b3d452bff7769d7f557ec6b8974760ee6c5e496c276652b654032966621e0ccf#7',
   'b3d452bff7769d7f557ec6b8974760ee6c5e496c276652b654032966621e0ccf#8',
   'b3d452bff7769d7f557ec6b8974760ee6c5e496c276652b654032966621e0ccf#9',
   'b3d452bff7769d7f557ec6b8974760ee6c5e496c276652b654032966621e0ccf#10',
   'fdd468da5cc4ac8431dcd7e2b3211666c73bc229f85879469f67f1d9d51d344d#0'
 );

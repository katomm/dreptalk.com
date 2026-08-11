-- Index for governance_actions.proposal_id lookups.
-- proposal_id holds the bech32 governance action id (gov_action1...). It is
-- the identifier external sites and users have at hand, and resolveIdentifier
-- looks it up with a plain equality match to redirect /ga/{id} to the
-- discussion thread. Without an index that lookup scans the whole table on
-- every request, which is fine at today's volume but not once explorers link
-- to /ga/{id} from their governance pages.
--
-- The other two id shapes already resolve through the primary key: CIP-129
-- hex is decoded to the "<txHash>#<index>" form before the query runs, and
-- that composite is the table's PK. Only the bech32 path was unindexed.
CREATE INDEX IF NOT EXISTS idx_governance_actions_proposal_id
  ON governance_actions (proposal_id);

-- Active constitutional-committee size (authorized, non-expired members), synced
-- from Koios committee_info alongside the quorum threshold. Feeds the CIP-1694
-- min-size rule on the governance-action detail page; the previous votes-cast
-- proxy wrongly showed "Not met" whenever some members simply had not voted.
ALTER TABLE protocol_params ADD COLUMN committee_size INTEGER;

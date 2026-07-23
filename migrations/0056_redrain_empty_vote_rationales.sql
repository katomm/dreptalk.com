-- One-time redrain of on-chain vote rationales stored as 'empty'. The extractor
-- now also reads the plain body.rationale field (CIP-108's name for the
-- statement), which several self-authored anchor documents use; rows written
-- before that fix were marked 'empty' and 'empty' is terminal (never retried).
-- Deleting them puts the votes back on the fetch queue's missing-row branch, so
-- the next rationale sync re-fetches and re-extracts each anchor.
DELETE FROM action_rationale WHERE source = 'onchain' AND status = 'empty';

-- One-time redrain of on-chain vote rationales stored as 'empty'. The extractor
-- now unwraps the JSON-LD expanded value form ({"@value": "..."}), which some
-- real anchors use for their comment; rows written before that fix were marked
-- 'empty' and 'empty' is terminal (never retried). Deleting them puts the votes
-- back on the fetch queue's missing-row branch, so the next rationale sync
-- re-fetches and re-extracts each anchor. Documents that are genuinely blank
-- simply land as 'empty' again.
DELETE FROM action_rationale WHERE source = 'onchain' AND status = 'empty';

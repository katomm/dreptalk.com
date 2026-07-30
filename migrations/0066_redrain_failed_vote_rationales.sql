-- One-time redrain of on-chain vote rationales stored as 'failed'. The anchor
-- verifier now tolerates whitespace-only serialization differences (tools such
-- as cgov.io / Mesh's hashDrepAnchor hash the pretty-printed document but publish
-- the minified bytes, so a byte-exact hash check missed a large, growing share of
-- otherwise valid rationales). Failed rows that exhausted their retry budget are
-- never re-attempted; deleting them puts the votes back on the fetch queue's
-- missing-row branch, so the next rationale sync re-fetches and re-verifies each
-- anchor. Genuinely dead or truly mismatched anchors simply land as 'failed'
-- again and settle.
DELETE FROM action_rationale WHERE source = 'onchain' AND status = 'failed';

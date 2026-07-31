-- One-time redrain of governance-action anchors given up as 'hash-mismatch'. The
-- anchor verifier now tolerates whitespace-only serialization differences (tools
-- such as cgov.io / Mesh's hashDrepAnchor hash the pretty-printed document but
-- publish the minified bytes, or the reverse), so a byte-exact hash check missed
-- otherwise valid metadata. Actions that exhausted their re-extraction budget
-- (meta_attempts >= 10) drop out of the backfill's re-read query and are never
-- retried, so anchors that failed before that fix shipped stay stuck even though
-- they would now verify. Zeroing meta_attempts puts them back on the re-extract
-- queue; the next governance sync re-fetches, and the whitespace-tolerant reverify
-- accepts the ones that match a canonical re-serialization. Genuinely mismatched
-- anchors simply climb back to the give-up cap and settle again.
UPDATE governance_actions
SET meta_attempts = 0
WHERE anchor_status = 'hash-mismatch' AND meta_attempts >= 10;

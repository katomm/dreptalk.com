-- One-time redrain of governance-action anchors given up as 'fetch-failed' while
-- their URL is a path-style IPFS gateway address (https://<host>/ipfs/<cid>).
-- Until now such a URL was fetched from that one host only, and a slow or
-- rate-limited public gateway burned the whole re-extraction budget
-- (meta_attempts reaching 10 drops the row out of the backfill for good) on a
-- document every other gateway serves by CID. The fetch path now falls through
-- to the other gateways, so zeroing meta_attempts puts these rows back on the
-- re-extract queue; the next governance sync re-reads the anchor through the
-- fallback list, and a genuinely dead CID simply climbs back to the cap.
UPDATE governance_actions
SET meta_attempts = 0
WHERE anchor_status = 'fetch-failed' AND instr(anchor_url, '/ipfs/') > 0 AND meta_attempts > 0;

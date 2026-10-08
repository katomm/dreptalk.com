-- One-time redrain of IPFS anchors given up before the dedicated gateway. The
-- public gateways rate limit the sync worker's shared egress with HTTP 429, and
-- the old fetch walk stored the status of the last gateway it tried, so a rate
-- limit showed up as 'fetch-failed' or 'bad-content-type' and burned the retry
-- budget. The fetch now tries a dedicated gateway first, so zeroing the attempt
-- counters puts these rows back on their queues. A genuinely dead CID simply
-- climbs back to its cap. Worst case, every row fails all its retries again:
-- about 1,100 requests to the dedicated gateway, well inside its 10,000 monthly
-- quota.
--
-- An IPFS anchor is an ipfs:// URL or a path-style gateway URL
-- (https://<host>/ipfs/<cid>), the two forms the fetch sends to the gateway.

-- Governance actions: meta_attempts reaching 10 drops a row out of the
-- metadata backfill for good.
UPDATE governance_actions
SET meta_attempts = 0
WHERE anchor_status IN ('fetch-failed', 'bad-content-type')
  AND (anchor_url LIKE 'ipfs:%' OR instr(anchor_url, '/ipfs/') > 0)
  AND meta_attempts > 0;

-- Vote rationales, DRep and SPO as well as committee: a failed row is retried
-- only while attempts stays under the cap (5). Back at 0 it is due again once
-- its last fetch is a day old, which holds for every row given up so far.
UPDATE action_rationale
SET attempts = 0
WHERE status = 'failed'
  AND (anchor_url LIKE 'ipfs:%' OR instr(anchor_url, '/ipfs/') > 0)
  AND attempts > 0;

-- DRep profiles are left out on purpose: the DRep sync re-fetches every anchor
-- whose stored status is not 'ok' on each run, with no attempt cap, so they are
-- retried through the dedicated gateway without a reset.

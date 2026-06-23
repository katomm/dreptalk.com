-- migrations/0035_vote_casting.sql
-- Vote casting: optimistic local vote rows and frozen rationale posts.
-- local_status: NULL = on-chain confirmed (authoritative sync), 'pending' = just
-- submitted, awaiting chain confirmation, 'failed' = not seen on chain after
-- several sync cycles. Authoritative upsertVotes uses INSERT OR REPLACE, which
-- resets local_status to NULL, so confirmation is automatic.
ALTER TABLE drep_votes ADD COLUMN local_status TEXT;
ALTER TABLE drep_votes ADD COLUMN tx_hash TEXT;

-- vote_rationale posts: a frozen, non-editable copy of an on-chain vote rationale.
-- source marks the post kind; vote carries the cast direction for the badge.
ALTER TABLE posts ADD COLUMN source TEXT;
ALTER TABLE posts ADD COLUMN vote TEXT;

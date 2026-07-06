-- Retroactively remove auto-created vote_rationale cross-posts from discussions.
-- Rationales are now cross-posted into a discussion only when the DRep opts in at
-- vote time. None of these existing posts had that consent, so remove them.
--
-- No topics.post_count correction is needed: these posts were inserted outside
-- the createReply path and were never counted, so soft-deleting them does not
-- change any topic's counter. Content is not lost, it remains on-chain and on the
-- Positions tab (action_rationale). deleted (not hidden) is used so no
-- "hidden by the community" badge is shown.
UPDATE posts SET deleted = 1 WHERE source = 'vote_rationale' AND deleted = 0;

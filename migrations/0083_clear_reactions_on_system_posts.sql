-- migrations/0083_clear_reactions_on_system_posts.sql
-- System posts (the gov-sync mirror of an on-chain action) no longer carry
-- reactions in either direction: the affordance is not rendered and the server
-- refuses both setting and withdrawing. Rows recorded while reacting to them
-- was allowed are therefore unreachable, and their materialized counts are read
-- by nothing. Delete the rows and zero the two counters so the table matches
-- what the product actually offers.
--
-- The counters can be set to zero outright rather than recomputed, because the
-- DELETE above leaves these posts with no reactions at all.
DELETE FROM post_reactions
WHERE post_id IN (SELECT id FROM posts WHERE author_id = 'gov-sync');

UPDATE posts
SET up_count = 0, down_count = 0
WHERE author_id = 'gov-sync' AND (up_count > 0 OR down_count > 0);

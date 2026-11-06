-- The post a reply actually answered. parent_post_id stays the top-level post
-- the reply is stored under (flat storage), so a reply to a reply loses its
-- real target there. This column keeps it, and the thread view nests replies
-- on it. NULL for top-level posts and for every reply written before this
-- column existed (the target was never stored, so there is nothing to
-- backfill).
ALTER TABLE posts ADD COLUMN reply_to_post_id TEXT;

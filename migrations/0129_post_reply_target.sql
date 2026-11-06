-- The post a reply actually answered. parent_post_id stays the top-level post
-- the reply is grouped under (one-level threading), so a reply to a reply
-- loses its real target there. This column keeps it, so the thread view can
-- nest replies under the reply they answered. NULL for top-level posts, for direct replies to a top-level post, and
-- for every reply written before this column existed (the target was never
-- stored, so there is nothing to backfill).
ALTER TABLE posts ADD COLUMN reply_to_post_id TEXT;

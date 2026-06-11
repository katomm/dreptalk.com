-- One-level reply threading: a post may reference a top-level post of the same
-- topic as its parent. NULL = top-level. The application enforces the single
-- level by lifting a reply-to-a-reply onto that reply's own parent.

ALTER TABLE posts ADD COLUMN parent_post_id TEXT;

-- Children of one parent, ordered by time (the thread page loads the children
-- of all parents on the page in one IN query, which never matches NULL).
-- Partial: replies are the minority of posts, so top-level inserts skip this
-- index entirely. Top-level pagination itself rides the existing
-- idx_posts_topic(topic_id, created_at) with a residual parent IS NULL filter.
CREATE INDEX idx_posts_parent ON posts(parent_post_id, created_at)
  WHERE parent_post_id IS NOT NULL;

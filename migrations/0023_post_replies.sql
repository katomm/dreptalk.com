-- One-level reply threading: a post may reference a top-level post of the same
-- topic as its parent. NULL = top-level. The application enforces the single
-- level by lifting a reply-to-a-reply onto that reply's own parent.

ALTER TABLE posts ADD COLUMN parent_post_id TEXT;

-- Children of one parent, ordered by time (the thread page loads the children
-- of all parents on the page in one IN query).
CREATE INDEX idx_posts_parent ON posts(parent_post_id, created_at);

-- Top-level pagination scans a topic's posts without parents; the partial
-- index keeps it as cheap as the old full topic scan.
CREATE INDEX idx_posts_topic_toplevel ON posts(topic_id, created_at) WHERE parent_post_id IS NULL;

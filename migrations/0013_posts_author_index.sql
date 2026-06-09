-- Supports the DRep profile's "forum activity" query (posts by one author,
-- newest first) without scanning the posts table.
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at);

-- SEO-friendly profile path segment for a pool, derived from the ticker (or
-- name) plus an id tail, e.g. "hype-4x9k2". Assigned once by the gov-sync
-- backfill and then sticky: a later ticker change never rewrites it, so profile
-- URLs stay stable. NULL for pools without a sluggable ticker/name; those keep
-- their id-based URL.
ALTER TABLE pools ADD COLUMN slug TEXT;
-- Unique across assigned slugs; SQLite treats NULLs as distinct, so the many
-- nameless rows can all stay NULL.
CREATE UNIQUE INDEX idx_pools_slug ON pools(slug);

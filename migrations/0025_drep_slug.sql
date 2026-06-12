-- SEO-friendly profile path segment derived from the CIP-119 name, e.g.
-- "lisa-cardano-9zulj". Assigned once by the sync backfill and then sticky:
-- a later name change never rewrites it, so profile URLs stay stable.
-- NULL for DReps without a (sluggable) name; those keep their id-based URL.
ALTER TABLE dreps ADD COLUMN slug TEXT;
-- Unique across assigned slugs; SQLite treats NULLs as distinct, so the many
-- nameless rows can all stay NULL.
CREATE UNIQUE INDEX idx_dreps_slug ON dreps(slug);

-- Marks a stored avatar as having been measured against the current size rule.
-- Avatars stored before that rule kept their source bytes, so a 1024px artwork
-- shown in a 38px list cell was served at full resolution. The refit pass walks
-- the rows still at 0, rewrites the oversized objects at display size, and
-- stamps them, so the candidate set shrinks to nothing and the pass costs one
-- empty query per run once it has drained.
--
-- Newly stored avatars are stamped as they are written: they already went
-- through the size rule on the way in. Existing rows default to 0 and are the
-- backfill's work queue.
ALTER TABLE dreps ADD COLUMN image_fit_checked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pools ADD COLUMN image_fit_checked INTEGER NOT NULL DEFAULT 0;

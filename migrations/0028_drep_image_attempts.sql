-- Counts how many times the avatar pass has failed to fetch or validate a DRep's
-- image URL. The pass gives up on a DRep once this reaches AVATAR_FETCH_MAX_ATTEMPTS,
-- so a permanently broken image (404, wrong type, oversize) stops being retried
-- every run, which otherwise pins the dreps sync at 'partial' forever and wastes
-- an image fetch per run. Reset to 0 by a successful store; existing rows start at
-- 0 and get the normal retry budget.
ALTER TABLE dreps ADD COLUMN image_fetch_attempts INTEGER NOT NULL DEFAULT 0;

-- Self-hosted avatar store columns.
-- image_content_hash: sha256 (hex) of the avatar bytes stored in R2 at
--   avatars/<hash>; drives the serve URL and "has a stored avatar".
-- image_stored_url: the source image_url we last successfully downloaded, so
--   the avatar store re-downloads only when the on-chain source URL changed.
ALTER TABLE dreps ADD COLUMN image_content_hash TEXT;
ALTER TABLE dreps ADD COLUMN image_stored_url TEXT;

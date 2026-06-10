-- Avatar store retry rotation.
-- image_fetch_failed_at: unix ms of the last failed download attempt; NULL when
--   never failed or after a successful store. The avatar work queue orders by
--   it ascending with NULLs first, so never-attempted rows are tried before
--   known-broken sources and a permanently failing source cannot starve fresh
--   work; it rotates to the back of the queue instead.
ALTER TABLE dreps ADD COLUMN image_fetch_failed_at INTEGER;

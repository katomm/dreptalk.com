-- End-to-end seed: one DRep with a valid CIP-129 id, applied after
-- scripts/seed-dev.sql. The dev seed's DRep ids are readable placeholders,
-- which the delegation tracking rejects, so the delegate test needs a real
-- encoding. The id is drep 0x22 header plus the credential hash in `hex`.
-- LOCAL USE ONLY. Re-runnable. Apply with: npm run db:seed:e2e
DELETE FROM dreps WHERE drep_id = 'drep1yt3wqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg8jz4t6';
INSERT INTO dreps (drep_id, hex, has_script, status, active, deposit, voting_power, expires_epoch_no, name, slug, bio, image_url, links, anchor_url, anchor_hash, anchor_status, registered_epoch, last_synced_at, created_at) VALUES
  ('drep1yt3wqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg8jz4t6', 'e2e00000000000000000000000000000000000000000000000000001', 0, 'registered', 1, '500000000', '1000000000000', 340, 'E2E Test DRep', 'e2e-test-drep', 'DRep row for the end-to-end tests.', NULL, '[]', NULL, NULL, 'ok', 300, strftime('%s','now')*1000, strftime('%s','now')*1000);

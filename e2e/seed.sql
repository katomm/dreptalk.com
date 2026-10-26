-- End-to-end seed: one DRep with a valid CIP-129 id, applied after
-- scripts/seed-dev.sql. The dev seed's DRep ids are readable placeholders,
-- which the delegation tracking rejects, so the delegate test needs a real
-- encoding. The id is drep 0x22 header plus the credential hash in `hex`.
-- Below it, the proposer and co-proposer fixtures of the co-proposer test.
-- LOCAL USE ONLY. Re-runnable. Apply with: npm run db:seed:e2e
DELETE FROM dreps WHERE drep_id = 'drep1yt3wqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg8jz4t6';
INSERT INTO dreps (drep_id, hex, has_script, status, active, deposit, voting_power, expires_epoch_no, name, slug, bio, image_url, links, anchor_url, anchor_hash, anchor_status, registered_epoch, last_synced_at, created_at) VALUES
  ('drep1yt3wqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg8jz4t6', 'e2e00000000000000000000000000000000000000000000000000001', 0, 'registered', 1, '500000000', '1000000000000', 340, 'E2E Test DRep', 'e2e-test-drep', 'DRep row for the end-to-end tests.', NULL, '[]', NULL, NULL, 'ok', 300, strftime('%s','now')*1000, strftime('%s','now')*1000);

-- Co-proposer flow (tests/co-proposer.spec.ts). The proposer P is account
-- 2147480001 of the default test mnemonic, its stake address derived with
-- prepareWallet({ accountIndex: 2147480001, networkId: 0 }) from cip30-test-wallet:
--   stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv
-- The co-proposer is a fresh account per run, the app rate-limits new topics
-- per account. P is the return address of three actions: two open ones with a
-- thread each, one enacted. The cleanup also removes what a previous run wrote:
-- replies in these threads, the drafts written under P's grants, the grants.
DELETE FROM post_reactions WHERE post_id IN (SELECT id FROM posts WHERE topic_id IN (SELECT id FROM topics WHERE id LIKE 'e2e-coprop-%' OR proposer_grant_id IN (SELECT id FROM proposer_grants WHERE proposer_stake_addr = 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv')));
DELETE FROM post_flags WHERE post_id IN (SELECT id FROM posts WHERE topic_id IN (SELECT id FROM topics WHERE id LIKE 'e2e-coprop-%' OR proposer_grant_id IN (SELECT id FROM proposer_grants WHERE proposer_stake_addr = 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv')));
DELETE FROM post_revisions WHERE post_id IN (SELECT id FROM posts WHERE topic_id IN (SELECT id FROM topics WHERE id LIKE 'e2e-coprop-%' OR proposer_grant_id IN (SELECT id FROM proposer_grants WHERE proposer_stake_addr = 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv')));
DELETE FROM notifications WHERE topic_id IN (SELECT id FROM topics WHERE id LIKE 'e2e-coprop-%' OR proposer_grant_id IN (SELECT id FROM proposer_grants WHERE proposer_stake_addr = 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv'));
DELETE FROM activity WHERE topic_id IN (SELECT id FROM topics WHERE id LIKE 'e2e-coprop-%' OR proposer_grant_id IN (SELECT id FROM proposer_grants WHERE proposer_stake_addr = 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv'));
DELETE FROM cip100_docs WHERE topic_id IN (SELECT id FROM topics WHERE id LIKE 'e2e-coprop-%' OR proposer_grant_id IN (SELECT id FROM proposer_grants WHERE proposer_stake_addr = 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv'));
DELETE FROM posts WHERE topic_id IN (SELECT id FROM topics WHERE id LIKE 'e2e-coprop-%' OR proposer_grant_id IN (SELECT id FROM proposer_grants WHERE proposer_stake_addr = 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv'));
DELETE FROM topics WHERE id IN (SELECT id FROM topics WHERE id LIKE 'e2e-coprop-%' OR proposer_grant_id IN (SELECT id FROM proposer_grants WHERE proposer_stake_addr = 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv'));
DELETE FROM proposer_grants WHERE proposer_stake_addr = 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv';
DELETE FROM governance_actions WHERE id IN (
  'e2ec0a000000000000000000000000000000000000000000000000000000c0a1#0',
  'e2ec0a000000000000000000000000000000000000000000000000000000c0a2#0',
  'e2ec0a000000000000000000000000000000000000000000000000000000c0a3#0'
);

INSERT INTO topics (id, category_slug, author_id, source, title, slug, pinned, locked, deleted, post_count, last_post_at, created_at) VALUES
  ('e2e-coprop-topic-1', 'governance-actions', 'gov-sync', 'governance', 'PFMS: Bringing Government Scale Adoption to Cardano by Trivolve Tech', 'pfms-bringing-government-scale-adoption-to-cardano-e2ec1', 0, 0, 0, 1, strftime('%s','now')*1000 - 1*86400000, strftime('%s','now')*1000 - 1*86400000),
  ('e2e-coprop-topic-2', 'governance-actions', 'gov-sync', 'governance', 'E2E Second Open Action of the Proposer', 'e2e-second-open-action-of-the-proposer-e2ec2', 0, 0, 0, 1, strftime('%s','now')*1000 - 5*86400000, strftime('%s','now')*1000 - 5*86400000),
  ('e2e-coprop-topic-3', 'governance-actions', 'gov-sync', 'governance', 'E2E Finished Action of the Proposer', 'e2e-finished-action-of-the-proposer-e2ec3', 0, 0, 0, 1, strftime('%s','now')*1000 - 60*86400000, strftime('%s','now')*1000 - 60*86400000);

INSERT INTO governance_actions (id, proposal_id, type, title, abstract, anchor_status, return_address, deposit, submitted_epoch, expiry_epoch, status, authors, submitted_at, topic_id, created_at, last_synced_at) VALUES
  ('e2ec0a000000000000000000000000000000000000000000000000000000c0a1#0', 'gov_action1e2ecoproposerpfmsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq1', 'TreasuryWithdrawals', 'PFMS: Bringing Government Scale Adoption to Cardano by Trivolve Tech', 'Fixture action for the co-proposer end-to-end test.', 'ok', 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv', '100000000000', 289, 295, 'active', '["Trivolve Tech","Cardano Foundation"]', strftime('%s','now')*1000 - 1*86400000, 'e2e-coprop-topic-1', strftime('%s','now')*1000 - 1*86400000, strftime('%s','now')*1000),
  ('e2ec0a000000000000000000000000000000000000000000000000000000c0a2#0', 'gov_action1e2ecoproposersecondqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2', 'InfoAction', 'E2E Second Open Action of the Proposer', 'Second open fixture action of the same return address.', 'ok', 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv', '100000000000', 288, 294, 'active', '["Trivolve Tech"]', strftime('%s','now')*1000 - 5*86400000, 'e2e-coprop-topic-2', strftime('%s','now')*1000 - 5*86400000, strftime('%s','now')*1000),
  ('e2ec0a000000000000000000000000000000000000000000000000000000c0a3#0', 'gov_action1e2ecoproposerfinishedqqqqqqqqqqqqqqqqqqqqqqqqqqqq3', 'InfoAction', 'E2E Finished Action of the Proposer', 'Enacted fixture action of the same return address.', 'ok', 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv', '100000000000', 270, 276, 'enacted', NULL, strftime('%s','now')*1000 - 60*86400000, 'e2e-coprop-topic-3', strftime('%s','now')*1000 - 60*86400000, strftime('%s','now')*1000);

INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at) VALUES
  ('e2e-coprop-post-1', 'e2e-coprop-topic-1', 'gov-sync', 'Fixture action for the co-proposer end-to-end test.', '<p>Fixture action for the co-proposer end-to-end test.</p>', strftime('%s','now')*1000 - 1*86400000),
  ('e2e-coprop-post-2', 'e2e-coprop-topic-2', 'gov-sync', 'Second open fixture action of the same return address.', '<p>Second open fixture action of the same return address.</p>', strftime('%s','now')*1000 - 5*86400000),
  ('e2e-coprop-post-3', 'e2e-coprop-topic-3', 'gov-sync', 'Enacted fixture action of the same return address.', '<p>Enacted fixture action of the same return address.</p>', strftime('%s','now')*1000 - 60*86400000);

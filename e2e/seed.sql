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

-- Thread map (tests/thread-map.spec.ts). Three plain budget topics and one
-- governance action with a long discussion. The posts are generated with a
-- counter so the fixture stays short. Bodies are a word repeated n times
-- (hex(zeroblob(n)) gives n "00" pairs). Reply schema: a direct reply has
-- parent_post_id and reply_to_post_id on the top-level post, a depth-2 reply
-- keeps parent_post_id on the top-level post and points reply_to_post_id at
-- the reply it answers.
DELETE FROM post_reactions WHERE post_id LIKE 'e2e-tmap-%';
DELETE FROM notifications WHERE topic_id LIKE 'e2e-tmap-%';
DELETE FROM activity WHERE topic_id LIKE 'e2e-tmap-%';
DELETE FROM posts WHERE topic_id LIKE 'e2e-tmap-%';
DELETE FROM topics WHERE id LIKE 'e2e-tmap-%';
DELETE FROM governance_actions WHERE id = 'e2e7a0000000000000000000000000000000000000000000000000000000e7a1#0';

INSERT INTO topics (id, category_slug, author_id, source, title, slug, pinned, locked, deleted, post_count, last_post_at, created_at) VALUES
  ('e2e-tmap-long', 'budget', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'user', 'E2E Thread Map Long Thread', 'e2e-thread-map-long-thread-e2e7a1', 0, 0, 0, 30, strftime('%s','now')*1000 - 1*86400000, strftime('%s','now')*1000 - 10*86400000),
  ('e2e-tmap-words', 'budget', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'user', 'E2E Thread Map Few Long Posts', 'e2e-thread-map-few-long-posts-e2e7a2', 0, 0, 0, 4, strftime('%s','now')*1000 - 1*86400000, strftime('%s','now')*1000 - 10*86400000),
  ('e2e-tmap-short', 'budget', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'user', 'E2E Thread Map Short Thread', 'e2e-thread-map-short-thread-e2e7a3', 0, 0, 0, 3, strftime('%s','now')*1000 - 1*86400000, strftime('%s','now')*1000 - 10*86400000),
  ('e2e-tmap-ga', 'governance-actions', 'gov-sync', 'governance', 'E2E Thread Map Governance Action', 'e2e-thread-map-governance-action-e2e7a4', 0, 0, 0, 26, strftime('%s','now')*1000 - 1*86400000, strftime('%s','now')*1000 - 10*86400000);

INSERT INTO governance_actions (id, proposal_id, type, title, abstract, anchor_status, return_address, deposit, submitted_epoch, expiry_epoch, status, authors, submitted_at, topic_id, created_at, last_synced_at) VALUES
  ('e2e7a0000000000000000000000000000000000000000000000000000000e7a1#0', 'gov_action1e2ethreadmapgovernanceqqqqqqqqqqqqqqqqqqqqqqqqqq1', 'InfoAction', 'E2E Thread Map Governance Action', 'Fixture action with a long discussion for the thread map test.', 'ok', NULL, '100000000000', 288, 294, 'active', '["E2E"]', strftime('%s','now')*1000 - 10*86400000, 'e2e-tmap-ga', strftime('%s','now')*1000 - 10*86400000, strftime('%s','now')*1000);

-- Five seeded DReps take turns as authors, the first one opens the long topic.
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30),
authors(k, id) AS (VALUES
  (0, 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6'),
  (1, 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3'),
  (2, 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5'),
  (3, 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5'),
  (4, 'drep1seedanonskepticd3f5g7h9j1k3l5z7x9c1v3b5n7m9q1w3e5r7t9y1u3')),
rows AS (
  SELECT i,
    'e2e-tmap-long-' || printf('%02d', i) AS id,
    CASE WHEN i IN (4, 5, 6) THEN 'e2e-tmap-long-03' WHEN i IN (10, 11, 12) THEN 'e2e-tmap-long-09' END AS parent,
    CASE WHEN i IN (4, 5) THEN 'e2e-tmap-long-03' WHEN i = 6 THEN 'e2e-tmap-long-05' WHEN i IN (10, 11, 12) THEN 'e2e-tmap-long-09' END AS reply_to,
    CASE WHEN i = 7 THEN 900 ELSE 40 + (i * 37) % 160 END AS words
  FROM n)
INSERT INTO posts (id, topic_id, author_id, body_md, body_html, parent_post_id, reply_to_post_id, created_at)
SELECT rows.id, 'e2e-tmap-long', authors.id,
  trim(replace(hex(zeroblob(words)), '00', 'budget ')),
  '<p>Post ' || i || ' ' || trim(replace(hex(zeroblob(words)), '00', 'budget ')) || '</p>',
  parent, reply_to, strftime('%s','now')*1000 - 10*86400000 + i * 3600000
FROM rows JOIN authors ON authors.k = (i - 1) % 5;

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4)
INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
SELECT 'e2e-tmap-words-' || i, 'e2e-tmap-words',
  CASE WHEN i = 1 THEN 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3' ELSE 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5' END,
  trim(replace(hex(zeroblob(900)), '00', 'treasury ')),
  '<p>' || trim(replace(hex(zeroblob(900)), '00', 'treasury ')) || '</p>',
  strftime('%s','now')*1000 - 10*86400000 + i * 3600000
FROM n;

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
SELECT 'e2e-tmap-short-' || i, 'e2e-tmap-short', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5',
  'A short post.', '<p>A short post.</p>', strftime('%s','now')*1000 - 10*86400000 + i * 3600000
FROM n;

-- Governance discussion: the system opener plus 25 posts of a few hundred
-- words, so the post column is clearly taller than the action's sidebar.
INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at) VALUES
  ('e2e-tmap-ga-00', 'e2e-tmap-ga', 'gov-sync', 'Fixture action with a long discussion for the thread map test.', '<p>Fixture action with a long discussion for the thread map test.</p>', strftime('%s','now')*1000 - 10*86400000);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25),
authors(k, id) AS (VALUES
  (0, 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6'),
  (1, 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3'),
  (2, 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5'),
  (3, 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5'),
  (4, 'drep1seedanonskepticd3f5g7h9j1k3l5z7x9c1v3b5n7m9q1w3e5r7t9y1u3'))
INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
SELECT 'e2e-tmap-ga-' || printf('%02d', i), 'e2e-tmap-ga', authors.id,
  trim(replace(hex(zeroblob(300)), '00', 'governance ')),
  '<p>' || trim(replace(hex(zeroblob(300)), '00', 'governance ')) || '</p>',
  strftime('%s','now')*1000 - 10*86400000 + i * 3600000
FROM n JOIN authors ON authors.k = (i - 1) % 5;

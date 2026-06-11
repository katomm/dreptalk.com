-- Development seed data: fake users (DReps, SPOs, CC), discussion topics with
-- conversations, two governance-action threads with tallies, per-author votes,
-- reactions, and one community-hidden post. LOCAL USE ONLY, never run against
-- a remote database. Re-runnable: every row carries a recognizable seed id and
-- is deleted up front. Apply with: npm run db:seed:local
--
-- Timestamps are unix milliseconds relative to "now" via strftime, so the
-- relative times in the UI always look fresh. Epoch numbers are calibrated for
-- PREPROD (local dev runs CARDANO_NETWORK=preprod; epoch ~290 in mid-2026), so
-- the rendered calendar dates look plausible.

-- ---------------------------------------------------------------------------
-- Cleanup of any previous seed run (children first).
-- ---------------------------------------------------------------------------
-- Posts are matched by topic too, so replies posted manually into seed topics
-- while testing are cleaned up as well.
DELETE FROM post_reactions WHERE post_id IN (SELECT id FROM posts WHERE topic_id LIKE 'seed-topic-%');
DELETE FROM post_flags WHERE post_id IN (SELECT id FROM posts WHERE topic_id LIKE 'seed-topic-%');
DELETE FROM posts WHERE topic_id LIKE 'seed-topic-%';
DELETE FROM topics WHERE id LIKE 'seed-topic-%';
DELETE FROM drep_votes WHERE ga_id IN (
  '5eedaa11bb22cc33dd44ee55ff660077889900aabbccddeeff00112233445566#0',
  '5eed2222aaaa4444bbbb6666cccc8888dddd0000eeee1111ffff2222abcd9876#0'
);
DELETE FROM governance_actions WHERE id IN (
  '5eedaa11bb22cc33dd44ee55ff660077889900aabbccddeeff00112233445566#0',
  '5eed2222aaaa4444bbbb6666cccc8888dddd0000eeee1111ffff2222abcd9876#0'
);
DELETE FROM dreps WHERE drep_id LIKE 'drep1seed%';
DELETE FROM users WHERE id LIKE 'drep1seed%' OR id LIKE 'pool1seed%' OR id LIKE 'cc_hot1seed%';

-- ---------------------------------------------------------------------------
-- Users: four DReps, two SPOs, one CC member, one DRep without a synced
-- profile (exercises the display-name fallback path).
-- ---------------------------------------------------------------------------
INSERT INTO users (id, drep_id, stake_addr, pool_id, cc_cred, is_drep, is_spo, is_cc, is_proposer, role, status, display_name, bio, avatar_url, created_at, last_verified_at) VALUES
  ('drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', NULL, NULL, NULL, 1, 0, 0, 0, 'member', 'active', 'Ada Hernandez', NULL, NULL, strftime('%s','now')*1000 - 90*86400000, strftime('%s','now')*1000 - 3600000),
  ('drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', NULL, NULL, NULL, 1, 0, 0, 0, 'member', 'active', 'Liam Park', NULL, NULL, strftime('%s','now')*1000 - 75*86400000, strftime('%s','now')*1000 - 7200000),
  ('drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', NULL, NULL, NULL, 1, 0, 0, 0, 'member', 'active', 'Maya Okafor', NULL, NULL, strftime('%s','now')*1000 - 60*86400000, strftime('%s','now')*1000 - 1800000),
  ('drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', NULL, NULL, NULL, 1, 0, 0, 0, 'member', 'active', 'Stefan Volkov', NULL, NULL, strftime('%s','now')*1000 - 45*86400000, strftime('%s','now')*1000 - 900000),
  ('drep1seedanonskepticd3f5g7h9j1k3l5z7x9c1v3b5n7m9q1w3e5r7t9y1u3', 'drep1seedanonskepticd3f5g7h9j1k3l5z7x9c1v3b5n7m9q1w3e5r7t9y1u3', NULL, NULL, NULL, 1, 0, 0, 0, 'member', 'active', 'Anon Skeptic', NULL, NULL, strftime('%s','now')*1000 - 10*86400000, strftime('%s','now')*1000 - 600000),
  ('pool1seednordicstakew9e1r3t5y7u9i1o3p5a7s9d1f3g5h7j9k1l3z5x7c9', NULL, NULL, 'pool1seednordicstakew9e1r3t5y7u9i1o3p5a7s9d1f3g5h7j9k1l3z5x7c9', NULL, 0, 1, 0, 0, 'member', 'active', 'Nordic Stakepool', NULL, NULL, strftime('%s','now')*1000 - 80*86400000, strftime('%s','now')*1000 - 5400000),
  ('pool1seedberlincollectivem2n4b6v8c0x1z3l5k7j9h1g3f5d7s9a1p3o5u7', NULL, NULL, 'pool1seedberlincollectivem2n4b6v8c0x1z3l5k7j9h1g3f5d7s9a1p3o5u7', NULL, 0, 1, 0, 0, 'member', 'active', 'Berlin Pool Collective', NULL, NULL, strftime('%s','now')*1000 - 70*86400000, strftime('%s','now')*1000 - 10800000),
  ('cc_hot1seedguardrailsr4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v2b4', NULL, NULL, NULL, 'cc_hot1seedguardrailsr4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v2b4', 0, 0, 1, 0, 'member', 'active', 'Guardrails Collective', NULL, NULL, strftime('%s','now')*1000 - 65*86400000, strftime('%s','now')*1000 - 2700000);

-- ---------------------------------------------------------------------------
-- Synced DRep profiles (drive display names, identicons, voting power).
-- The "Anon Skeptic" DRep deliberately has no row here.
-- ---------------------------------------------------------------------------
INSERT INTO dreps (drep_id, hex, has_script, status, active, deposit, voting_power, expires_epoch_no, name, bio, image_url, links, anchor_url, anchor_hash, anchor_status, registered_epoch, last_synced_at, created_at) VALUES
  ('drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'aada111122223333444455556666777788889999aaaabbbbccccddde', 0, 'registered', 1, '500000000', '12500000000000', 306, 'Ada Hernandez', 'Independent DRep focused on infrastructure and developer experience.', NULL, '[]', 'https://example.org/dreps/ada.jsonld', 'aa11bb22cc33dd44ee55ff660077889900aabbccddeeff001122334455667788', 'ok', 194, strftime('%s','now')*1000 - 3600000, strftime('%s','now')*1000 - 90*86400000),
  ('drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', '11aa222233334444555566667777888899990000aaaabbbbccccddd1', 0, 'registered', 1, '500000000', '4200000000000', 304, 'Liam Park', 'DRep and educator. I publish a rationale for every vote I cast.', NULL, '[]', 'https://example.org/dreps/liam.jsonld', 'bb22cc33dd44ee55ff660077889900aabbccddeeff00112233445566778899aa', 'ok', 202, strftime('%s','now')*1000 - 3600000, strftime('%s','now')*1000 - 75*86400000),
  ('drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', '22bb333344445555666677778888999900001111aaaabbbbccccddd2', 0, 'registered', 1, '500000000', '8900000000000', 308, 'Maya Okafor', 'Treasury hawk. Every lovelace spent should have a measurable outcome.', NULL, '[]', 'https://example.org/dreps/maya.jsonld', 'cc33dd44ee55ff660077889900aabbccddeeff00112233445566778899aabb22', 'ok', 190, strftime('%s','now')*1000 - 3600000, strftime('%s','now')*1000 - 60*86400000),
  ('drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', '33cc444455556666777788889999000011112222aaaabbbbccccddd3', 0, 'registered', 1, '500000000', '1400000000000', 302, 'Stefan Volkov', 'Small DRep representing long-term holders in central Europe.', NULL, '[]', 'https://example.org/dreps/stefan.jsonld', 'dd44ee55ff660077889900aabbccddeeff00112233445566778899aabbcc3344', 'ok', 206, strftime('%s','now')*1000 - 3600000, strftime('%s','now')*1000 - 45*86400000);

-- ---------------------------------------------------------------------------
-- Protocol params (voting thresholds for the governance sidebar). Single row.
-- ---------------------------------------------------------------------------
INSERT OR REPLACE INTO protocol_params (id, epoch, dvt_motion_no_confidence, dvt_committee_normal, dvt_committee_no_confidence, dvt_update_constitution, dvt_hard_fork, dvt_pp_network, dvt_pp_economic, dvt_pp_technical, dvt_pp_gov, dvt_treasury_withdrawal, pvt_motion_no_confidence, pvt_committee_normal, pvt_committee_no_confidence, pvt_hard_fork, pvt_security_group, cc_threshold, committee_min_size, synced_at)
VALUES (1, 290, 0.67, 0.67, 0.6, 0.75, 0.6, 0.67, 0.67, 0.67, 0.75, 0.67, 0.51, 0.51, 0.51, 0.51, 0.51, 0.67, 7, strftime('%s','now')*1000);

-- ---------------------------------------------------------------------------
-- Governance action 1 (active InfoAction) + its discussion thread.
-- Topic post_count/last_post_at are inserted as 0 placeholders everywhere:
-- the recompute UPDATEs at the bottom derive them from the posts table.
-- ---------------------------------------------------------------------------
INSERT INTO topics (id, category_slug, author_id, source, title, slug, pinned, locked, deleted, post_count, last_post_at, created_at) VALUES
  ('seed-topic-ga1', 'governance-actions', 'gov-sync', 'governance', 'Fund Core Infrastructure Development 2026', 'fund-core-infrastructure-development-2026-5eed1', 0, 0, 0, 0, 0, strftime('%s','now')*1000 - 8*86400000);

INSERT INTO governance_actions (id, proposal_id, type, title, abstract, rationale_html, anchor_url, anchor_hash, anchor_status, return_address, deposit, submitted_epoch, expiry_epoch, status, drep_yes, drep_no, drep_abstain, spo_yes, spo_no, spo_abstain, cc_yes, cc_no, cc_abstain, drep_yes_pct, drep_no_pct, spo_yes_pct, spo_no_pct, cc_yes_pct, cc_no_pct, drep_voted_power, tally_epoch, tally_synced_at, votes_synced_at, decided_epoch, trending_score, meta_version, topic_id, created_at, last_synced_at) VALUES
  ('5eedaa11bb22cc33dd44ee55ff660077889900aabbccddeeff00112233445566#0', 'gov_action1seedinfra2026qqqqqqqqqqqqqqqqqqqqqqqqqqpzklpgpf', 'InfoAction', 'Fund Core Infrastructure Development 2026', 'A coordinated proposal to fund core node, ledger, and tooling work through 2026, covering maintenance, performance work, and security audits across the core repositories.', '<p>Core infrastructure carries every other project in the ecosystem. This proposal asks the community to signal support for a 2026 work program covering:</p><ul><li>Node and ledger maintenance, including two scheduled performance releases</li><li>Continuous fuzzing and an external security audit per quarter</li><li>Developer tooling: stable APIs, faster CI images, reproducible builds</li></ul><p>Deliverables are tracked in public quarterly milestones, and unspent funds return to the treasury.</p>', 'https://example.org/actions/infra-2026.jsonld', 'ee55ff660077889900aabbccddeeff00112233445566778899aabbccdd445566', 'ok', 'stake1seedproposerintersect0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '100000000000', 288, 294, 'active', 42, 17, 6, 31, 12, 4, 5, 1, 1, 61.4, 22.1, 55.0, 30.2, 71.4, 14.3, 18500000000000, 290, strftime('%s','now')*1000 - 1800000, strftime('%s','now')*1000 - 1800000, NULL, 100.0, 1, 'seed-topic-ga1', strftime('%s','now')*1000 - 8*86400000, strftime('%s','now')*1000 - 1800000);

INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, synced_at) VALUES
  ('5eedaa11bb22cc33dd44ee55ff660077889900aabbccddeeff00112233445566#0', 'DRep', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'aada111122223333444455556666777788889999aaaabbbbccccddde', 'Yes', 'https://example.org/rationales/ada-infra.jsonld', strftime('%s','now')*1000 - 1800000),
  ('5eedaa11bb22cc33dd44ee55ff660077889900aabbccddeeff00112233445566#0', 'DRep', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', '11aa222233334444555566667777888899990000aaaabbbbccccddd1', 'Yes', 'https://example.org/rationales/liam-infra.jsonld', strftime('%s','now')*1000 - 1800000),
  ('5eedaa11bb22cc33dd44ee55ff660077889900aabbccddeeff00112233445566#0', 'DRep', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', '22bb333344445555666677778888999900001111aaaabbbbccccddd2', 'No', NULL, strftime('%s','now')*1000 - 1800000),
  ('5eedaa11bb22cc33dd44ee55ff660077889900aabbccddeeff00112233445566#0', 'DRep', 'drep1seedvoterquietwhale7f9g1h3j5k7l9z1x3c5v7b9n1m3q5w7e9r1t3', NULL, 'Yes', NULL, strftime('%s','now')*1000 - 1800000),
  ('5eedaa11bb22cc33dd44ee55ff660077889900aabbccddeeff00112233445566#0', 'DRep', 'drep1seedvoterabstainer0p2a4s6d8f0g2h4j6k8l0z2x4c6v8b0n2m4q6w8', NULL, 'Abstain', NULL, strftime('%s','now')*1000 - 1800000);

INSERT INTO posts (id, topic_id, author_id, body_md, body_html, edited_at, created_at) VALUES
  ('seed-post-ga1-0', 'seed-topic-ga1', 'gov-sync', 'A coordinated proposal to fund core node, ledger, and tooling work through 2026.

[Read the full rationale](https://example.org/actions/infra-2026.jsonld)', '<p>A coordinated proposal to fund core node, ledger, and tooling work through 2026.</p><p><a href="https://example.org/actions/infra-2026.jsonld" rel="noopener noreferrer nofollow ugc">Read the full rationale</a></p>', NULL, strftime('%s','now')*1000 - 8*86400000),
  ('seed-post-ga1-1', 'seed-topic-ga1', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'I fully support this proposal. Investing in core infrastructure is essential for the long-term reliability and scalability of Cardano. The team has a strong track record and the quarterly milestone structure gives us real checkpoints.', '<p>I fully support this proposal. Investing in core infrastructure is essential for the long-term reliability and scalability of Cardano. The team has a strong track record and the quarterly milestone structure gives us real checkpoints.</p>', NULL, strftime('%s','now')*1000 - 2*3600000),
  ('seed-post-ga1-2', 'seed-topic-ga1', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'I agree with the goal, but I would like more clarity on how success will be measured.

- What are the key deliverables per quarter?
- Who signs off on a milestone before the next tranche?', '<p>I agree with the goal, but I would like more clarity on how success will be measured.</p><ul><li>What are the key deliverables per quarter?</li><li>Who signs off on a milestone before the next tranche?</li></ul>', NULL, strftime('%s','now')*1000 - 45*60000),
  ('seed-post-ga1-3', 'seed-topic-ga1', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'I have concerns about the budget allocation. Can we get a more detailed breakdown of costs and how this compares to similar projects? Without unit costs per work stream I cannot justify a yes to my delegators.', '<p>I have concerns about the budget allocation. Can we get a more detailed breakdown of costs and how this compares to similar projects? Without unit costs per work stream I cannot justify a yes to my delegators.</p>', NULL, strftime('%s','now')*1000 - 30*60000),
  ('seed-post-ga1-4', 'seed-topic-ga1', 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', 'Good point. Transparency on costs would help build more confidence in this proposal. A public ledger of spend per milestone, like other treasury projects publish, seems like a reasonable ask.', '<p>Good point. Transparency on costs would help build more confidence in this proposal. A public ledger of spend per milestone, like other treasury projects publish, seems like a reasonable ask.</p>', NULL, strftime('%s','now')*1000 - 28*60000),
  ('seed-post-ga1-5', 'seed-topic-ga1', 'pool1seednordicstakew9e1r3t5y7u9i1o3p5a7s9d1f3g5h7j9k1l3z5x7c9', 'From an operator perspective: the relay performance work in this program is overdue. We have been carrying patches downstream for two epochs that belong upstream.', '<p>From an operator perspective: the relay performance work in this program is overdue. We have been carrying patches downstream for two epochs that belong upstream.</p>', NULL, strftime('%s','now')*1000 - 12*60000);

-- ---------------------------------------------------------------------------
-- Governance action 2 (enacted TreasuryWithdrawals) + a short thread.
-- ---------------------------------------------------------------------------
INSERT INTO topics (id, category_slug, author_id, source, title, slug, pinned, locked, deleted, post_count, last_post_at, created_at) VALUES
  ('seed-topic-ga2', 'governance-actions', 'gov-sync', 'governance', 'Q3 2026 Open Source Tooling Budget', 'q3-2026-open-source-tooling-budget-5eed2', 0, 0, 0, 0, 0, strftime('%s','now')*1000 - 21*86400000);

INSERT INTO governance_actions (id, proposal_id, type, title, abstract, rationale_html, anchor_url, anchor_hash, anchor_status, return_address, deposit, submitted_epoch, expiry_epoch, status, drep_yes, drep_no, drep_abstain, spo_yes, spo_no, spo_abstain, cc_yes, cc_no, cc_abstain, drep_yes_pct, drep_no_pct, spo_yes_pct, spo_no_pct, cc_yes_pct, cc_no_pct, drep_voted_power, tally_epoch, tally_synced_at, votes_synced_at, decided_epoch, trending_score, meta_version, topic_id, created_at, last_synced_at) VALUES
  ('5eed2222aaaa4444bbbb6666cccc8888dddd0000eeee1111ffff2222abcd9876#0', 'gov_action1seedtooling2026qqqqqqqqqqqqqqqqqqqqqqqqzklpgaa', 'TreasuryWithdrawals', 'Q3 2026 Open Source Tooling Budget', 'Treasury withdrawal funding the Q3 2026 budget for open source wallet libraries, SDK maintenance, and documentation work approved in the annual budget process.', '<p>This withdrawal executes the open source tooling line of the approved 2026 budget. Funds are held by the budget administrator and paid out against published milestones.</p>', 'https://example.org/actions/tooling-q3-2026.jsonld', 'ff660077889900aabbccddeeff00112233445566778899aabbccddee55667788', 'ok', 'stake1seedproposerintersect0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '100000000000', 282, 288, 'enacted', 88, 9, 12, NULL, NULL, NULL, 6, 0, 1, 78.9, 8.1, NULL, NULL, 85.7, 0.0, 21300000000000, 287, strftime('%s','now')*1000 - 26*3600000, strftime('%s','now')*1000 - 26*3600000, 287, 40.0, 1, 'seed-topic-ga2', strftime('%s','now')*1000 - 21*86400000, strftime('%s','now')*1000 - 26*3600000);

INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, synced_at) VALUES
  ('5eed2222aaaa4444bbbb6666cccc8888dddd0000eeee1111ffff2222abcd9876#0', 'DRep', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'aada111122223333444455556666777788889999aaaabbbbccccddde', 'Yes', NULL, strftime('%s','now')*1000 - 26*3600000),
  ('5eed2222aaaa4444bbbb6666cccc8888dddd0000eeee1111ffff2222abcd9876#0', 'DRep', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', '22bb333344445555666677778888999900001111aaaabbbbccccddd2', 'Yes', 'https://example.org/rationales/maya-tooling.jsonld', strftime('%s','now')*1000 - 26*3600000);

INSERT INTO posts (id, topic_id, author_id, body_md, body_html, edited_at, created_at) VALUES
  ('seed-post-ga2-0', 'seed-topic-ga2', 'gov-sync', 'Treasury withdrawal funding the Q3 2026 budget for open source wallet libraries, SDK maintenance, and documentation work.

[Read the full rationale](https://example.org/actions/tooling-q3-2026.jsonld)', '<p>Treasury withdrawal funding the Q3 2026 budget for open source wallet libraries, SDK maintenance, and documentation work.</p><p><a href="https://example.org/actions/tooling-q3-2026.jsonld" rel="noopener noreferrer nofollow ugc">Read the full rationale</a></p>', NULL, strftime('%s','now')*1000 - 21*86400000),
  ('seed-post-ga2-1', 'seed-topic-ga2', 'cc_hot1seedguardrailsr4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v2b4', 'Constitutional check passed: the withdrawal stays inside the approved budget envelope and names an accountable administrator. Our full review is linked from the vote rationale.', '<p>Constitutional check passed: the withdrawal stays inside the approved budget envelope and names an accountable administrator. Our full review is linked from the vote rationale.</p>', NULL, strftime('%s','now')*1000 - 2*86400000),
  ('seed-post-ga2-2', 'seed-topic-ga2', 'pool1seedberlincollectivem2n4b6v8c0x1z3l5k7j9h1g3f5d7s9a1p3o5u7', 'Glad to see the SDK maintenance line funded. The wallet connector breakage last quarter cost every operator real support hours.', '<p>Glad to see the SDK maintenance line funded. The wallet connector breakage last quarter cost every operator real support hours.</p>', NULL, strftime('%s','now')*1000 - 26*3600000);

-- ---------------------------------------------------------------------------
-- Discussion topic: Budget and Treasury.
-- ---------------------------------------------------------------------------
INSERT INTO topics (id, category_slug, author_id, source, title, slug, pinned, locked, deleted, post_count, last_post_at, created_at) VALUES
  ('seed-topic-b1', 'budget', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'user', 'Treasury runway: how many funding rounds can we actually afford?', 'treasury-runway-how-many-funding-rounds-can-we-afford-5eed3', 0, 0, 0, 0, 0, strftime('%s','now')*1000 - 3*86400000);

INSERT INTO posts (id, topic_id, author_id, body_md, body_html, edited_at, created_at) VALUES
  ('seed-post-b1-0', 'seed-topic-b1', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'Before we approve the next wave of withdrawals, I want us to look at the runway honestly.

> The treasury is not a faucet. It is a war chest with a burn rate.

My back-of-the-envelope numbers:

- Current balance: roughly 1.5B ada
- 2026 committed spend so far: about 350M ada
- Inflow is trending down as reserves shrink

At this pace we have maybe four more annual cycles at current spend. I would like to see every proposal state its share of annual outflow.', '<p>Before we approve the next wave of withdrawals, I want us to look at the runway honestly.</p><blockquote><p>The treasury is not a faucet. It is a war chest with a burn rate.</p></blockquote><p>My back-of-the-envelope numbers:</p><ul><li>Current balance: roughly 1.5B ada</li><li>2026 committed spend so far: about 350M ada</li><li>Inflow is trending down as reserves shrink</li></ul><p>At this pace we have maybe four more annual cycles at current spend. I would like to see every proposal state its share of annual outflow.</p>', NULL, strftime('%s','now')*1000 - 3*86400000),
  ('seed-post-b1-1', 'seed-topic-b1', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'Good framing. One nuance: not all spend is equal. Infrastructure and security spend protects the value of the remaining treasury, while one-off marketing spend does not compound. I would rather see a category-level budget ceiling than a flat cut.', '<p>Good framing. One nuance: not all spend is equal. Infrastructure and security spend protects the value of the remaining treasury, while one-off marketing spend does not compound. I would rather see a category-level budget ceiling than a flat cut.</p>', NULL, strftime('%s','now')*1000 - 2*86400000),
  ('seed-post-b1-2', 'seed-topic-b1', 'pool1seednordicstakew9e1r3t5y7u9i1o3p5a7s9d1f3g5h7j9k1l3z5x7c9', 'From the SPO side: please also model the fee income realistically. Network fees cover only a small slice of outflow today, so "the treasury refills itself" is not a serious argument yet.', '<p>From the SPO side: please also model the fee income realistically. Network fees cover only a small slice of outflow today, so &quot;the treasury refills itself&quot; is not a serious argument yet.</p>', NULL, strftime('%s','now')*1000 - 4*3600000),
  ('seed-post-b1-3', 'seed-topic-b1', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'I built a small dashboard for exactly this question last month. Happy to share the methodology in a separate thread if there is interest. Short version: we are fine for 2026, tight by 2028 unless inflows change.', '<p>I built a small dashboard for exactly this question last month. Happy to share the methodology in a separate thread if there is interest. Short version: we are fine for 2026, tight by 2028 unless inflows change.</p>', NULL, strftime('%s','now')*1000 - 55*60000);

-- ---------------------------------------------------------------------------
-- Discussion topic: Constitution and Guardrails.
-- ---------------------------------------------------------------------------
INSERT INTO topics (id, category_slug, author_id, source, title, slug, pinned, locked, deleted, post_count, last_post_at, created_at) VALUES
  ('seed-topic-c1', 'constitution', 'cc_hot1seedguardrailsr4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v2b4', 'user', 'Are the parameter change guardrails too permissive?', 'are-the-parameter-change-guardrails-too-permissive-5eed4', 0, 0, 0, 0, 0, strftime('%s','now')*1000 - 5*86400000);

INSERT INTO posts (id, topic_id, author_id, body_md, body_html, edited_at, created_at) VALUES
  ('seed-post-c1-0', 'seed-topic-c1', 'cc_hot1seedguardrailsr4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v2b4', 'During the last review cycle we noticed that several economic parameters can move by large steps within a single action while still passing the written guardrails. Concretely, `minFeeA` can quadruple in one step.

We would like community input on two options:

1. Tighten the per-action step limits in the guardrails appendix
2. Keep the limits but require a cooling-off period between consecutive changes to the same parameter', '<p>During the last review cycle we noticed that several economic parameters can move by large steps within a single action while still passing the written guardrails. Concretely, <code>minFeeA</code> can quadruple in one step.</p><p>We would like community input on two options:</p><ol><li>Tighten the per-action step limits in the guardrails appendix</li><li>Keep the limits but require a cooling-off period between consecutive changes to the same parameter</li></ol>', NULL, strftime('%s','now')*1000 - 5*86400000),
  ('seed-post-c1-1', 'seed-topic-c1', 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', 'Option 2 feels right to me. Hard step limits always end up either too loose in a crisis or too tight in normal times. A cooling-off period keeps flexibility while preventing rapid-fire changes that nobody can model.', '<p>Option 2 feels right to me. Hard step limits always end up either too loose in a crisis or too tight in normal times. A cooling-off period keeps flexibility while preventing rapid-fire changes that nobody can model.</p>', NULL, strftime('%s','now')*1000 - 3*86400000),
  ('seed-post-c1-2', 'seed-topic-c1', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'Could we get the historical data on how often a parameter changed twice within, say, ten epochs? If it has never happened, option 2 costs us nothing. If it happens regularly, we need to understand why first.', '<p>Could we get the historical data on how often a parameter changed twice within, say, ten epochs? If it has never happened, option 2 costs us nothing. If it happens regularly, we need to understand why first.</p>', NULL, strftime('%s','now')*1000 - 90*60000);

-- ---------------------------------------------------------------------------
-- Discussion topic: General (includes an edited post and a community-hidden
-- post so both render paths are visible).
-- ---------------------------------------------------------------------------
INSERT INTO topics (id, category_slug, author_id, source, title, slug, pinned, locked, deleted, post_count, last_post_at, created_at) VALUES
  ('seed-topic-g1', 'general', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'user', 'Which tools are you using for your DRep workflow?', 'which-tools-are-you-using-for-your-drep-workflow-5eed5', 0, 0, 0, 0, 0, strftime('%s','now')*1000 - 36*3600000);

INSERT INTO posts (id, topic_id, author_id, body_md, body_html, edited_at, created_at) VALUES
  ('seed-post-g1-0', 'seed-topic-g1', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'Curious what everyone uses day to day. My current stack:

- A spreadsheet for tracking open actions and my draft positions
- A script that pulls new actions from Koios every morning
- A plain text file of rationale templates

What I am missing is a good way to discuss drafts with other DReps before voting, which is hopefully what this forum becomes.', '<p>Curious what everyone uses day to day. My current stack:</p><ul><li>A spreadsheet for tracking open actions and my draft positions</li><li>A script that pulls new actions from Koios every morning</li><li>A plain text file of rationale templates</li></ul><p>What I am missing is a good way to discuss drafts with other DReps before voting, which is hopefully what this forum becomes.</p>', NULL, strftime('%s','now')*1000 - 36*3600000),
  ('seed-post-g1-1', 'seed-topic-g1', 'pool1seednordicstakew9e1r3t5y7u9i1o3p5a7s9d1f3g5h7j9k1l3z5x7c9', 'We run a small internal wiki for the pool where we summarize every action before deciding. The summaries take maybe twenty minutes each but delegators love them.', '<p>We run a small internal wiki for the pool where we summarize every action before deciding. The summaries take maybe twenty minutes each but delegators love them.</p>', NULL, strftime('%s','now')*1000 - 30*3600000),
  ('seed-post-g1-2', 'seed-topic-g1', 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', 'Mostly the explorer plus a notebook. I keep a one-page decision log per action with the date, my vote, and two sentences of reasoning. Searchable history beats memory.

Edit: typo fixed, "decision log" not "descision log".', '<p>Mostly the explorer plus a notebook. I keep a one-page decision log per action with the date, my vote, and two sentences of reasoning. Searchable history beats memory.</p><p>Edit: typo fixed, &quot;decision log&quot; not &quot;descision log&quot;.</p>', strftime('%s','now')*1000 - 22*3600000, strftime('%s','now')*1000 - 23*3600000),
  ('seed-post-g1-3', 'seed-topic-g1', 'drep1seedanonskepticd3f5g7h9j1k3l5z7x9c1v3b5n7m9q1w3e5r7t9y1u3', 'None of this matters, the whales decide everything anyway and you are all wasting your time pretending otherwise.', '<p>None of this matters, the whales decide everything anyway and you are all wasting your time pretending otherwise.</p>', NULL, strftime('%s','now')*1000 - 5*3600000),
  ('seed-post-g1-4', 'seed-topic-g1', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'Adding one: I keep a delegator-facing changelog. Every vote gets one paragraph in plain language. It is the single most appreciated thing I publish.', '<p>Adding one: I keep a delegator-facing changelog. Every vote gets one paragraph in plain language. It is the single most appreciated thing I publish.</p>', NULL, strftime('%s','now')*1000 - 20*60000);

-- One-level threading examples: Stefan answers Maya's cost concern on the
-- governance thread (mirrors the design mockup), Ada answers Stefan's
-- cooling-off argument in the constitution thread.
UPDATE posts SET parent_post_id = 'seed-post-ga1-3' WHERE id = 'seed-post-ga1-4';
UPDATE posts SET parent_post_id = 'seed-post-c1-1' WHERE id = 'seed-post-c1-2';

-- Community flags that hide the dismissive post (threshold is 3 distinct writers).
INSERT INTO post_flags (post_id, flagger_id, created_at) VALUES
  ('seed-post-g1-3', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', strftime('%s','now')*1000 - 4*3600000),
  ('seed-post-g1-3', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', strftime('%s','now')*1000 - 4*3600000),
  ('seed-post-g1-3', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', strftime('%s','now')*1000 - 3*3600000);

-- ---------------------------------------------------------------------------
-- Reactions (thumbs up / down). Counts are recomputed below, so these rows are
-- the single source of truth.
-- ---------------------------------------------------------------------------
INSERT INTO post_reactions (post_id, reactor_id, reaction, created_at) VALUES
  -- GA1 opening post: 12 up, 3 down.
  ('seed-post-ga1-0', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'up', strftime('%s','now')*1000 - 7*86400000),
  ('seed-post-ga1-0', 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', 'up', strftime('%s','now')*1000 - 7*86400000),
  ('seed-post-ga1-0', 'pool1seednordicstakew9e1r3t5y7u9i1o3p5a7s9d1f3g5h7j9k1l3z5x7c9', 'up', strftime('%s','now')*1000 - 6*86400000),
  ('seed-post-ga1-0', 'pool1seedberlincollectivem2n4b6v8c0x1z3l5k7j9h1g3f5d7s9a1p3o5u7', 'up', strftime('%s','now')*1000 - 6*86400000),
  ('seed-post-ga1-0', 'cc_hot1seedguardrailsr4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v2b4', 'up', strftime('%s','now')*1000 - 5*86400000),
  ('seed-post-ga1-0', 'seed-fan-1', 'up', strftime('%s','now')*1000 - 5*86400000),
  ('seed-post-ga1-0', 'seed-fan-2', 'up', strftime('%s','now')*1000 - 4*86400000),
  ('seed-post-ga1-0', 'seed-fan-3', 'up', strftime('%s','now')*1000 - 4*86400000),
  ('seed-post-ga1-0', 'seed-fan-4', 'up', strftime('%s','now')*1000 - 3*86400000),
  ('seed-post-ga1-0', 'seed-fan-5', 'up', strftime('%s','now')*1000 - 2*86400000),
  ('seed-post-ga1-0', 'seed-fan-6', 'up', strftime('%s','now')*1000 - 86400000),
  ('seed-post-ga1-0', 'seed-fan-7', 'up', strftime('%s','now')*1000 - 3600000),
  ('seed-post-ga1-0', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'down', strftime('%s','now')*1000 - 5*86400000),
  ('seed-post-ga1-0', 'seed-fan-8', 'down', strftime('%s','now')*1000 - 2*86400000),
  ('seed-post-ga1-0', 'seed-fan-9', 'down', strftime('%s','now')*1000 - 86400000),
  -- Ada's supporting reply: 5 up.
  ('seed-post-ga1-1', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'up', strftime('%s','now')*1000 - 100*60000),
  ('seed-post-ga1-1', 'pool1seednordicstakew9e1r3t5y7u9i1o3p5a7s9d1f3g5h7j9k1l3z5x7c9', 'up', strftime('%s','now')*1000 - 95*60000),
  ('seed-post-ga1-1', 'pool1seedberlincollectivem2n4b6v8c0x1z3l5k7j9h1g3f5d7s9a1p3o5u7', 'up', strftime('%s','now')*1000 - 90*60000),
  ('seed-post-ga1-1', 'seed-fan-1', 'up', strftime('%s','now')*1000 - 80*60000),
  ('seed-post-ga1-1', 'seed-fan-2', 'up', strftime('%s','now')*1000 - 70*60000),
  -- Liam's questions: 3 up.
  ('seed-post-ga1-2', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'up', strftime('%s','now')*1000 - 40*60000),
  ('seed-post-ga1-2', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'up', strftime('%s','now')*1000 - 38*60000),
  ('seed-post-ga1-2', 'seed-fan-3', 'up', strftime('%s','now')*1000 - 35*60000),
  -- Maya's concern: 3 up, 1 down.
  ('seed-post-ga1-3', 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', 'up', strftime('%s','now')*1000 - 27*60000),
  ('seed-post-ga1-3', 'cc_hot1seedguardrailsr4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v2b4', 'up', strftime('%s','now')*1000 - 25*60000),
  ('seed-post-ga1-3', 'seed-fan-4', 'up', strftime('%s','now')*1000 - 22*60000),
  ('seed-post-ga1-3', 'seed-fan-5', 'down', strftime('%s','now')*1000 - 20*60000),
  -- Stefan's reply: 2 up.
  ('seed-post-ga1-4', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'up', strftime('%s','now')*1000 - 26*60000),
  ('seed-post-ga1-4', 'seed-fan-6', 'up', strftime('%s','now')*1000 - 24*60000),
  -- GA2 opening: 4 up.
  ('seed-post-ga2-0', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'up', strftime('%s','now')*1000 - 10*86400000),
  ('seed-post-ga2-0', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'up', strftime('%s','now')*1000 - 9*86400000),
  ('seed-post-ga2-0', 'pool1seedberlincollectivem2n4b6v8c0x1z3l5k7j9h1g3f5d7s9a1p3o5u7', 'up', strftime('%s','now')*1000 - 8*86400000),
  ('seed-post-ga2-0', 'seed-fan-1', 'up', strftime('%s','now')*1000 - 7*86400000),
  -- Budget thread opener: 6 up, 1 down.
  ('seed-post-b1-0', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'up', strftime('%s','now')*1000 - 2*86400000),
  ('seed-post-b1-0', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'up', strftime('%s','now')*1000 - 2*86400000),
  ('seed-post-b1-0', 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', 'up', strftime('%s','now')*1000 - 2*86400000),
  ('seed-post-b1-0', 'pool1seednordicstakew9e1r3t5y7u9i1o3p5a7s9d1f3g5h7j9k1l3z5x7c9', 'up', strftime('%s','now')*1000 - 86400000),
  ('seed-post-b1-0', 'cc_hot1seedguardrailsr4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v2b4', 'up', strftime('%s','now')*1000 - 86400000),
  ('seed-post-b1-0', 'seed-fan-2', 'up', strftime('%s','now')*1000 - 86400000),
  ('seed-post-b1-0', 'seed-fan-7', 'down', strftime('%s','now')*1000 - 86400000),
  -- A couple in the other threads.
  ('seed-post-b1-2', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'up', strftime('%s','now')*1000 - 3*3600000),
  ('seed-post-c1-1', 'cc_hot1seedguardrailsr4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v2b4', 'up', strftime('%s','now')*1000 - 2*86400000),
  ('seed-post-c1-1', 'drep1seedadahernandezxq8f7w2lk9p3m5r6t0v4y7c2e5h8j1n4q7s0u3w6', 'up', strftime('%s','now')*1000 - 86400000),
  ('seed-post-g1-0', 'drep1seedstefanvolkovk7l9z1x3c5v7b9n1m3q5w7e9r1t3y5u7i9o1p3a5', 'up', strftime('%s','now')*1000 - 30*3600000),
  ('seed-post-g1-0', 'drep1seedmayaokaforv5b7n9m1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5', 'up', strftime('%s','now')*1000 - 28*3600000),
  ('seed-post-g1-4', 'drep1seedliamparkq2w4e6r8t0y1u3i5o7p9a1s3d5f7g9h1j3k5l7z9x1c3', 'up', strftime('%s','now')*1000 - 15*60000);

-- ---------------------------------------------------------------------------
-- Recompute every materialized counter from its source-of-truth table, so the
-- seed can never drift from the recompute logic the app uses at runtime.
-- ---------------------------------------------------------------------------
UPDATE posts SET
  up_count   = (SELECT COUNT(*) FROM post_reactions WHERE post_id = posts.id AND reaction = 'up'),
  down_count = (SELECT COUNT(*) FROM post_reactions WHERE post_id = posts.id AND reaction = 'down'),
  flag_count = (SELECT COUNT(*) FROM post_flags WHERE post_id = posts.id),
  hidden     = CASE WHEN (SELECT COUNT(*) FROM post_flags WHERE post_id = posts.id) >= 3 THEN 1 ELSE 0 END
WHERE id LIKE 'seed-post-%';

UPDATE topics SET
  post_count   = (SELECT COUNT(*) FROM posts WHERE topic_id = topics.id AND deleted = 0),
  last_post_at = (SELECT MAX(created_at) FROM posts WHERE topic_id = topics.id AND deleted = 0)
WHERE id LIKE 'seed-topic-%';

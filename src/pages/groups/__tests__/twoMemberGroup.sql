-- An open group with two named members, a 2 of 2 control policy, a profile with one script-controlled
-- treasury address and three history entries. Local D1 only:
-- npx wrangler d1 execute DB --local --persist-to .wrangler/state --file src/pages/groups/__tests__/twoMemberGroup.sql
INSERT OR REPLACE INTO dreps (drep_id, status, voting_power, last_synced_at, created_at, name, slug)
  VALUES ('drep1y2s6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgg68q7a8', 'registered', '2000000000', 0, 0, 'Alice Example', NULL);
INSERT OR REPLACE INTO dreps (drep_id, status, voting_power, last_synced_at, created_at, name, slug)
  VALUES ('drep1y2et9v4jk2et9v4jk2et9v4jk2et9v4jk2et9v4jk2et9vsj6dv46', 'registered', '1000000000', 0, 0, 'Bob Example', NULL);
INSERT OR REPLACE INTO drep_groups (group_tx, group_ix, cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, profile_url, profile_hash,
    seq, status, created_h, created_ti, created_ph, created_ix, created_tx,
    profile_set_h, profile_set_ti, profile_set_ph, profile_set_ix, profile_set_tx, members, applied_events, member_power)
  VALUES (X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 0,
    100, 0, 2, 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 'open',
    X'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', 'https://example.test/group.json', X'0a', '1', 'active',
    100, 0, 2, 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
    100, 0, 2, 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 2, 3, 3000000000);
INSERT OR REPLACE INTO drep_group_scripts (hash, at_h, at_ti, at_ph, at_ix, at_tx, bytes, display_json)
  VALUES (X'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', 100, 0, 2, 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
    X'830302828200581ca1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a18200581cb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
    '{"type":"nOfK","n":"2","scripts":[{"type":"sig","keyHash":"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"},{"type":"sig","keyHash":"b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"}]}');
INSERT OR REPLACE INTO drep_group_scripts (hash, at_h, at_ti, at_ph, at_ix, at_tx, bytes, display_json)
  VALUES (X'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 100, 0, 2, 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
    X'8201828200581ca1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a18200581ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
    '{"type":"all","scripts":[{"type":"sig","keyHash":"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"},{"type":"sig","keyHash":"e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"}]}');
INSERT OR REPLACE INTO drep_group_profiles (group_tx, group_ix, profile_url, data_hash, status, name, description, website, charter,
    payment_addresses_json, fetched_at)
  VALUES (X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 0, 'https://example.test/group.json', X'0a', 'ok',
    'Example Council', 'Two DReps who publish their rationales together.', 'https://example.test', NULL,
    '[{"address":"addr_test1wrpu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8scknledl","purpose":"Treasury","treasuryScript":"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"}]', 0);
INSERT OR REPLACE INTO drep_group_instances (join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode,
    joined_h, joined_ti, joined_ph, joined_ix, joined_tx, counted_as)
  VALUES (X'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1', 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 0,
    X'00a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'drep1y2s6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgg68q7a8', 'open',
    101, 0, 2, 0, X'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1', 'open');
INSERT OR REPLACE INTO drep_group_instances (join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode,
    joined_h, joined_ti, joined_ph, joined_ix, joined_tx, counted_as)
  VALUES (X'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 0,
    X'00b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', 'drep1y2et9v4jk2et9v4jk2et9v4jk2et9v4jk2et9v4jk2et9vsj6dv46', 'open',
    102, 0, 2, 0, X'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', 'open');
INSERT OR REPLACE INTO drep_group_verdicts (tx_hash, idx, group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, tag, valid)
  VALUES (X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 0,
    100, 0, 2, 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 'create', 1);
INSERT OR REPLACE INTO drep_group_verdicts (tx_hash, idx, group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, tag, valid)
  VALUES (X'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1', 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 0,
    101, 0, 2, 0, X'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1', 'join', 1);
INSERT OR REPLACE INTO drep_group_verdicts (tx_hash, idx, group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, tag, valid)
  VALUES (X'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', 0, X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 0,
    102, 0, 2, 0, X'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', 'join', 1);
-- INSERT OR REPLACE of the group row above resets its listing count on a second run, the triggers
-- of the instances only move it, so the count is taken again from the stored leads.
UPDATE drep_groups SET counted_members = (SELECT COUNT(*) FROM drep_group_leads l
    WHERE l.group_tx = drep_groups.group_tx AND l.group_ix = drep_groups.group_ix)
  WHERE group_tx = X'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0' AND group_ix = 0;

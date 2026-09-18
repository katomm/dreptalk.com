-- Extends the constitutional committee membership timeline (seeded in 0048) with
-- the committee enacted at epoch 654 by
-- gov_action1w2w64uhelz0cg2np7m37hal905tdd7jpzm3fcyc3g7qvkwgfppgqqfsggt5, the
-- 2026 election result. The live committee sync only updates members it already
-- knows, so without this the two newly seated credentials were missing from the
-- roster and the committee yes-percentage denominator (5 instead of 7).
--
-- Close the epoch 602 version at 653. The live sync keeps term_expiration of the
-- current version in step with Koios, so the two re-elected seats already carry
-- their new 799 term there. Restore the 653 term that version actually had.
UPDATE committee_member SET version_to = 653 WHERE version_from = 602 AND version_to IS NULL;
UPDATE committee_member SET term_expiration = 653
 WHERE version_from = 602
   AND cold_key_hex IN ('13493790d9b03483a1e1e684ea4faf1ee48a58f402574e7f2246f4d4', '16feefc225e06f75a3c917f4aa50acffde7631ea0355721f2ac12542');

-- The seven seats from epoch 654. authorized_from is the epoch of the earliest
-- hot-key registration (db-sync committee_registration).
INSERT OR REPLACE INTO committee_member (cold_key_hex, version_from, version_to, term_expiration, authorized_from, resigned_at) VALUES
  ('0af99047bc90e0d9073467548a19a85089b766e73eb807748a2ad361', 654, NULL, 799, 654, NULL),
  ('13493790d9b03483a1e1e684ea4faf1ee48a58f402574e7f2246f4d4', 654, NULL, 799, 586, NULL),
  ('16feefc225e06f75a3c917f4aa50acffde7631ea0355721f2ac12542', 654, NULL, 799, 602, NULL),
  ('1980dbf1ad624b0cb5410359b5ab14d008561994a6c2b6c53fabec00', 654, NULL, 726, 581, NULL),
  ('7c34e0240b84029e0932f5e8d81af42a63f55de6da31f16e19b1f5b4', 654, NULL, 799, 653, NULL),
  ('84aebcfd3e00d0f87af918fc4b5e00135f407e379893df7e7d392c6a', 654, NULL, 726, 508, NULL),
  ('9752e4306e5ae864441d21064f791174c8b626199b8e7a45f9e03b45', 654, NULL, 726, 582, NULL);

-- Hot keys of the two new seats. The live sync registers them too, OR IGNORE
-- keeps this safe where it already did.
INSERT OR IGNORE INTO committee_hot_key (hot_key_hex, cold_key_hex) VALUES
  ('21f39fb376b5029105b805c3689c96e2e7230d3ee4d595410f813f4c', '7c34e0240b84029e0932f5e8d81af42a63f55de6da31f16e19b1f5b4'),
  ('b1806f7aa969a9e354ebb54462658d2b88fdbf4802f882ea62894e64', '0af99047bc90e0d9073467548a19a85089b766e73eb807748a2ad361');

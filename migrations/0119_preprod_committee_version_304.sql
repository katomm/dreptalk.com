-- Seeds the preprod constitutional committee timeline. Migrations run on every
-- network, so the mainnet seeds 0048 and 0105 also wrote mainnet members into the
-- preprod database. Their epochs never cover a preprod epoch, so the preprod
-- timeline counted no committee at all.
--
-- Every statement is gated on the preprod committee's hot key, which the live
-- committee sync registers on preprod from Koios committee_info. Mainnet never
-- holds it, so this migration changes nothing there.
--
-- Only the committee in force since epoch 304 is seeded, enacted by
-- gov_action1h0arqw4rt5verxf5ld07x6chgcy6pswlk3a9gmxdd6jc4f6ju24qqj0haqp, which
-- removed eleven seats and left three, each with a term through epoch 372.
-- Before 304 preprod saw hundreds of committee votes from hot keys that never
-- map to a seat, so earlier boundaries stay uncovered, as before.
-- authorized_from is the epoch of the first committee vote cast with the
-- member's current hot key (Koios vote_list), the latest its hot key can have
-- been registered. Every boundary from 304 on sees all three authorized.

-- Drop the mainnet rows the shared seeds left behind.
DELETE FROM committee_hot_key
 WHERE cold_key_hex NOT IN (
         '615b54137e73f090d2dddb04317bee41624f4013e5cfe4a5efa76d76',
         'e36d5e45b277bff4962d6c63be2375af8e68e558e6a373137a0ad6f2',
         'e883ad4599af7b01fe9d01c92bfa405151226db53982931d445b4a96')
   AND EXISTS (SELECT 1 FROM committee_hot_key WHERE hot_key_hex = '5bfa7d850280c54110534065fa91a3635bbcc0eadc69c5c792c35e1e');

DELETE FROM committee_member
 WHERE EXISTS (SELECT 1 FROM committee_hot_key WHERE hot_key_hex = '5bfa7d850280c54110534065fa91a3635bbcc0eadc69c5c792c35e1e');

INSERT INTO committee_member (cold_key_hex, version_from, version_to, term_expiration, authorized_from, resigned_at)
SELECT column1, 304, NULL, 372, column2, NULL
  FROM (VALUES
    ('615b54137e73f090d2dddb04317bee41624f4013e5cfe4a5efa76d76', 230),
    ('e36d5e45b277bff4962d6c63be2375af8e68e558e6a373137a0ad6f2', 230),
    ('e883ad4599af7b01fe9d01c92bfa405151226db53982931d445b4a96', 230))
 WHERE EXISTS (SELECT 1 FROM committee_hot_key WHERE hot_key_hex = '5bfa7d850280c54110534065fa91a3635bbcc0eadc69c5c792c35e1e');

-- The other two hot keys, in case the live sync has not stored them yet.
INSERT OR IGNORE INTO committee_hot_key (hot_key_hex, cold_key_hex)
SELECT column1, column2
  FROM (VALUES
    ('26648e2c6bc4e4863a373bd28d480b2eb788922545e1df357e76a3d2', 'e36d5e45b277bff4962d6c63be2375af8e68e558e6a373137a0ad6f2'),
    ('19ebff7033fe1c1f9cd2b346f2c9b0d7ff28b1527ebed1cc071155b4', 'e883ad4599af7b01fe9d01c92bfa405151226db53982931d445b4a96'))
 WHERE EXISTS (SELECT 1 FROM committee_hot_key WHERE hot_key_hex = '5bfa7d850280c54110534065fa91a3635bbcc0eadc69c5c792c35e1e');

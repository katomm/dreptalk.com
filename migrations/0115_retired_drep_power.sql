-- Retired DReps kept the voting power drep_info reported right after their
-- retirement, which is the last epoch snapshot they were counted in. The sync
-- never touches a deregistered row again, so that amount stayed on the row
-- and was summed as stake still delegated to inactive DReps. A retired DRep
-- holds no voting power, the sync now stores zero at retirement, and this
-- clears the rows written before that.

-- The vote sync copied that frozen amount into the votes these DReps had cast
-- on actions still open at their retirement. Open actions pick up zero on
-- their next vote sync, closed ones are never synced again. These are the
-- mainnet votes on actions decided in a later epoch than the DRep's
-- retirement (retirement epochs from the chain), when the vote no longer
-- counted. Guarded on the frozen amount so a row written since is left
-- alone. Must run before the dreps update below, which clears that amount.
UPDATE drep_votes SET voted_power = 0
 WHERE voter_role = 'DRep'
   AND (voter_id, ga_id) IN (
     VALUES
       -- retired in epoch 651
       ('drep1y2vyrqh0fa4qh4tmy7322va6ryk78uh6szppezaft0watyqp5hdwx', 'ab474223d40e2e3540555364be27e161a809c33651408f43d84acff10c0ba306#0'),
       ('drep1y2vyrqh0fa4qh4tmy7322va6ryk78uh6szppezaft0watyqp5hdwx', '729daaf2f9f89f842a61f6e3ebf7e57d16d6fa4116e29c13114780cb39090850#0'),
       -- retired in epoch 647
       ('drep1yfk64j2zmjssfyucggmgjr56clagysx2ct5ucqlf4nq8hrqp23kfa', '2f429bde312c0806bd16199da10f4145da9807161e99d4486174c6fb9a91f983#0'),
       ('drep1yfk64j2zmjssfyucggmgjr56clagysx2ct5ucqlf4nq8hrqp23kfa', '529dccaadaa000746c22f1682574cb3f436eeba4d19710b90791a54226dc96d7#0'),
       ('drep1yfk64j2zmjssfyucggmgjr56clagysx2ct5ucqlf4nq8hrqp23kfa', '48bab0ca71cc46f2ee421242b14f292b8c8382bda707d03ea662644bed22b893#0'),
       ('drep1yfk64j2zmjssfyucggmgjr56clagysx2ct5ucqlf4nq8hrqp23kfa', 'ab474223d40e2e3540555364be27e161a809c33651408f43d84acff10c0ba306#0'),
       ('drep1yfk64j2zmjssfyucggmgjr56clagysx2ct5ucqlf4nq8hrqp23kfa', '729daaf2f9f89f842a61f6e3ebf7e57d16d6fa4116e29c13114780cb39090850#0'),
       -- retired in epoch 655
       ('drep1yg3fzjm63hjg37k3rtdt7wx0mgmn303lwv2s50xxkjzsv5qfhynxg', 'f57f8fcb4e83ad1b6f58bffd4a302aacbb5a90874c83c5f84a7f8b4bb43ce9bc#0'),
       ('drep1yg3fzjm63hjg37k3rtdt7wx0mgmn303lwv2s50xxkjzsv5qfhynxg', '7d37220b71806410cc8adfbdafbad494e1ce3fdc674ab13c88a72b3b27de78d9#0'),
       -- retired in epoch 653
       ('drep1yghm3canzwv736un9usqrxpfvxrm68k9hz0ppvrxe7n7lfgmsxru8', 'f57f8fcb4e83ad1b6f58bffd4a302aacbb5a90874c83c5f84a7f8b4bb43ce9bc#0'),
       ('drep1yghm3canzwv736un9usqrxpfvxrm68k9hz0ppvrxe7n7lfgmsxru8', '7d37220b71806410cc8adfbdafbad494e1ce3fdc674ab13c88a72b3b27de78d9#0')
   )
   AND voted_power = (
     SELECT CAST(d.voting_power AS INTEGER) FROM dreps d WHERE d.drep_id = drep_votes.voter_id
   );

UPDATE dreps SET voting_power = '0'
 WHERE status = 'deregistered'
   AND voting_power IS NOT NULL
   AND voting_power <> '0';

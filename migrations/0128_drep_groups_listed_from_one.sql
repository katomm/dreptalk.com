-- The group list's partial index covers every group with a member. The listing threshold is
-- LISTED_MIN_MEMBERS in src/lib/groups/constants.ts, the queries keep the index term members >= 1
-- literally and add the threshold as a second filter when it is above 1, so raising it later
-- needs no new index.
DROP INDEX IF EXISTS drep_groups_listed;
CREATE INDEX IF NOT EXISTS drep_groups_listed ON drep_groups (member_power DESC, group_tx, group_ix) WHERE members >= 1;

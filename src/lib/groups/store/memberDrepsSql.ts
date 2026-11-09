// Binds the group twice. The DReps with an open instance in the group, none while it is closing.
// A module without imports, so the DRep list filter carries no other groups code.
export const GROUP_MEMBER_DREPS_SQL = `SELECT i.drep_id FROM drep_group_instances i WHERE i.group_tx = ? AND i.group_ix = ? AND i.counted_as = 'open'
          AND NOT EXISTS (SELECT 1 FROM drep_groups g WHERE g.group_tx = ? AND g.group_ix = ? AND g.closing = 1)`;

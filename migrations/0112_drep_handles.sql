-- drep.link handles: short names that redirect drep.link/<handle> to a DRep's
-- profile. One primary handle per DRep, plus at most one previous handle that
-- keeps redirecting until released_at. A row is live while released_at is NULL
-- or in the future. Written by the reviewed launch seed, the gov-sync
-- drep-handles phase and the DRep claim endpoint.
CREATE TABLE IF NOT EXISTS drep_handles (
  handle TEXT PRIMARY KEY,
  drep_id TEXT NOT NULL,
  source TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1,
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drep_handles_drep ON drep_handles(drep_id);
-- One primary per DRep. A concurrent second change trips this and rolls back.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drep_handles_primary ON drep_handles(drep_id) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_drep_handles_released ON drep_handles(released_at) WHERE released_at IS NOT NULL;

-- Stamped once the automatic path has decided on a DRep (assigned or skipped),
-- so the steady-state candidate read returns nothing and a handle revoked by
-- hand is never re-created.
ALTER TABLE dreps ADD COLUMN handle_auto_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_dreps_handle_auto_pending ON dreps(registered_at)
  WHERE handle_auto_at IS NULL AND name IS NOT NULL AND status = 'registered';

-- Launch gate: exactly one row once the reviewed seed is applied. Claims and the
-- automatic phase stay off until then. The CHECK makes a second seed fail.
CREATE TABLE IF NOT EXISTS drep_handle_seed (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seeded_at INTEGER NOT NULL
);

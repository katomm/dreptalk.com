-- The group list counts every DRep toward one group only: its oldest open membership by join
-- position, ties broken by the group key (tx hash bytes, then index). drep_group_leads holds that
-- group per credential and drep_groups.counted_members the number of credentials it counts. A
-- group is listed when counted_members reaches LISTED_MIN_MEMBERS in src/lib/groups/constants.ts,
-- so one DRep cannot list many groups. members keeps every open membership and stays what pages show.
--
-- Triggers on drep_group_instances keep both in step with counted_as, so every writer moves the
-- count in the same statement: the commit upsert, the job cache writes (dissolve, retire,
-- recompute) and the recovery deletes. Each trigger derives the credential's lead again from
-- scratch with one seek on drep_group_instances_lead. That also holds for INSERT OR REPLACE, whose
-- implicit delete skips the delete trigger: the insert trigger replaces the old lead. A group row
-- is deleted only together with its instances (every join is at or after the group's creation),
-- so no lead outlives its group.
--
-- The listed partial index keys on counted_members >= 1. The queries keep that term literally and
-- add the threshold as a second filter when it is above 1, so raising it later needs no new index.
--
-- Website checks follow the listing. A trigger on counted_members makes a group's website due when
-- it becomes listed and its stored profile of the current anchor names a website, so a group that
-- is listed later gets checked on the next run. It never deletes: a lead move rebuilds the count
-- with a decrement and an increment, and a delete there would reset the schedule. A due row of a
-- group that is no longer listed is stale and the due page drops it. The trigger crosses at 1, the
-- value of LISTED_MIN_MEMBERS, and a test fails when the two differ, so raising the constant needs
-- a migration that recreates the trigger.

ALTER TABLE drep_groups ADD COLUMN counted_members INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS drep_group_leads (
  cred BLOB PRIMARY KEY,
  group_tx BLOB NOT NULL,
  group_ix INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS drep_group_instances_lead ON drep_group_instances
  (cred, joined_h, joined_ti, joined_ph, joined_ix, group_tx, group_ix) WHERE counted_as = 'open';

-- Backfill from the stored instances.
INSERT OR IGNORE INTO drep_group_leads (cred, group_tx, group_ix)
SELECT cred, group_tx, group_ix FROM (
  SELECT cred, group_tx, group_ix, ROW_NUMBER() OVER (
    PARTITION BY cred ORDER BY joined_h, joined_ti, joined_ph, joined_ix, group_tx, group_ix) AS rn
  FROM drep_group_instances WHERE counted_as = 'open')
WHERE rn = 1;
UPDATE drep_groups SET counted_members = c.n
  FROM (SELECT group_tx, group_ix, COUNT(*) AS n FROM drep_group_leads GROUP BY group_tx, group_ix) AS c
  WHERE drep_groups.group_tx = c.group_tx AND drep_groups.group_ix = c.group_ix;

DROP INDEX IF EXISTS drep_groups_listed;
CREATE INDEX IF NOT EXISTS drep_groups_listed ON drep_groups (member_power DESC, group_tx, group_ix) WHERE counted_members >= 1;

CREATE TRIGGER IF NOT EXISTS drep_group_instances_lead_ai AFTER INSERT ON drep_group_instances
WHEN NEW.counted_as = 'open' OR EXISTS (SELECT 1 FROM drep_group_leads
  WHERE cred = NEW.cred AND group_tx = NEW.group_tx AND group_ix = NEW.group_ix) BEGIN
  UPDATE drep_groups SET counted_members = counted_members - 1
    WHERE (group_tx, group_ix) IN (SELECT group_tx, group_ix FROM drep_group_leads WHERE cred = NEW.cred);
  DELETE FROM drep_group_leads WHERE cred = NEW.cred;
  INSERT INTO drep_group_leads (cred, group_tx, group_ix)
    SELECT cred, group_tx, group_ix FROM drep_group_instances WHERE cred = NEW.cred AND counted_as = 'open'
    ORDER BY joined_h, joined_ti, joined_ph, joined_ix, group_tx, group_ix LIMIT 1;
  UPDATE drep_groups SET counted_members = counted_members + 1
    WHERE (group_tx, group_ix) IN (SELECT group_tx, group_ix FROM drep_group_leads WHERE cred = NEW.cred);
END;

CREATE TRIGGER IF NOT EXISTS drep_group_instances_lead_au AFTER UPDATE OF counted_as ON drep_group_instances
WHEN OLD.counted_as IS NOT NEW.counted_as AND (OLD.counted_as = 'open' OR NEW.counted_as = 'open') BEGIN
  UPDATE drep_groups SET counted_members = counted_members - 1
    WHERE (group_tx, group_ix) IN (SELECT group_tx, group_ix FROM drep_group_leads WHERE cred = NEW.cred);
  DELETE FROM drep_group_leads WHERE cred = NEW.cred;
  INSERT INTO drep_group_leads (cred, group_tx, group_ix)
    SELECT cred, group_tx, group_ix FROM drep_group_instances WHERE cred = NEW.cred AND counted_as = 'open'
    ORDER BY joined_h, joined_ti, joined_ph, joined_ix, group_tx, group_ix LIMIT 1;
  UPDATE drep_groups SET counted_members = counted_members + 1
    WHERE (group_tx, group_ix) IN (SELECT group_tx, group_ix FROM drep_group_leads WHERE cred = NEW.cred);
END;

CREATE TRIGGER IF NOT EXISTS drep_group_instances_lead_ad AFTER DELETE ON drep_group_instances
WHEN OLD.counted_as = 'open' BEGIN
  UPDATE drep_groups SET counted_members = counted_members - 1
    WHERE (group_tx, group_ix) IN (SELECT group_tx, group_ix FROM drep_group_leads WHERE cred = OLD.cred);
  DELETE FROM drep_group_leads WHERE cred = OLD.cred;
  INSERT INTO drep_group_leads (cred, group_tx, group_ix)
    SELECT cred, group_tx, group_ix FROM drep_group_instances WHERE cred = OLD.cred AND counted_as = 'open'
    ORDER BY joined_h, joined_ti, joined_ph, joined_ix, group_tx, group_ix LIMIT 1;
  UPDATE drep_groups SET counted_members = counted_members + 1
    WHERE (group_tx, group_ix) IN (SELECT group_tx, group_ix FROM drep_group_leads WHERE cred = OLD.cred);
END;

CREATE TRIGGER IF NOT EXISTS drep_groups_website_due AFTER UPDATE OF counted_members ON drep_groups
WHEN OLD.counted_members < 1 AND NEW.counted_members >= 1 BEGIN
  INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at)
    SELECT 'website', p.group_tx, p.group_ix, 0 FROM drep_group_profiles p
    WHERE p.group_tx = NEW.group_tx AND p.group_ix = NEW.group_ix AND p.website IS NOT NULL
      AND p.profile_url = NEW.profile_url AND p.data_hash = NEW.profile_hash
    ON CONFLICT (kind, group_tx, group_ix) DO NOTHING;
END;

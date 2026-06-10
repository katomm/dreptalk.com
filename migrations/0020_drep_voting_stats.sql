-- Voting stats for DRep profiles: per-vote rationale anchor + DRep registration epoch.

-- Rationale anchor attached to an individual on-chain vote. NULL / '' means the
-- DRep voted without attaching a rationale link. Already present in the
-- /proposal_votes response we fetch; we stop discarding it. Drives the rationale rate.
ALTER TABLE drep_votes ADD COLUMN meta_url TEXT;

-- Epoch in which this DRep first registered. Backfilled from /drep_updates and
-- left untouched by the profile upsert, so it survives every sync. Drives the
-- participation denominator (a DRep cannot have voted on actions whose voting
-- window closed before it registered).
ALTER TABLE dreps ADD COLUMN registered_epoch INTEGER;

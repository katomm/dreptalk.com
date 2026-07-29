-- Per-voter decisive voting power for the voting-trend chart. Lovelace the voter
-- weighed with at the time of its final vote (DRep: local dreps.voting_power; SPO:
-- Koios active_stake). NULL for CC (count-weighted via the committee timeline) and
-- until the enrichment fills it. Owned by the vote-sync power enrichment, not the
-- vote upsert's core columns; a COALESCE upsert never nulls a good value.
ALTER TABLE drep_votes ADD COLUMN voted_power INTEGER;

-- Frozen per-body threshold snapshot for an action, so a historical threshold line
-- is the one in force when the action was decided, not today's protocol params.
-- thresholds_json is { "drep": pct|null, "spo": pct|null, "cc": pct|null } (0..100);
-- thresholds_epoch is the epoch the snapshot was evaluated for. Both NULL until the
-- tally sync writes them; frozen once the action turns terminal.
ALTER TABLE governance_actions ADD COLUMN thresholds_json TEXT;
ALTER TABLE governance_actions ADD COLUMN thresholds_epoch INTEGER;

-- Reserves balance (lovelace) per epoch, from the same Koios /totals row as
-- treasury_lovelace. Feeds the treasury runway, whose inflow and reserve decay
-- are measured over the last closed epochs. Older rows are filled by a one-off
-- backfill (scripts/backfill-epoch-reserves.mjs).
ALTER TABLE governance_epoch_stats ADD COLUMN reserves_lovelace TEXT;

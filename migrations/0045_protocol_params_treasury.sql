-- Cardano treasury and reserves balances in lovelace, plus the epoch they are
-- from, synced from Koios /totals. Shown on the treasury page to give the Net
-- Change Limit its context: how much ada is actually in the treasury.
ALTER TABLE protocol_params ADD COLUMN treasury_lovelace TEXT;
ALTER TABLE protocol_params ADD COLUMN reserves_lovelace TEXT;
ALTER TABLE protocol_params ADD COLUMN treasury_epoch INTEGER;

-- Circulating supply (lovelace) captured alongside treasury/reserves from
-- Koios /totals, single-row snapshot like the other params. Feeds the
-- analytics hub's "share of circulating ada delegated" vital.
ALTER TABLE protocol_params ADD COLUMN circulation_lovelace TEXT;

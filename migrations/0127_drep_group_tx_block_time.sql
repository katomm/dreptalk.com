-- Block time of every stored DRep group transaction in unix seconds, written at ingest so the group
-- page history needs no Koios call. Rows stored before this column get it from a bounded backfill
-- in the DRep groups phase, which walks the partial index below until no row is left in it.
ALTER TABLE drep_group_txs ADD COLUMN block_time INTEGER;
CREATE INDEX IF NOT EXISTS drep_group_txs_no_time ON drep_group_txs (block_height) WHERE block_time IS NULL;

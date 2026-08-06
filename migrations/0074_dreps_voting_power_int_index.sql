-- Expression index for dreps.voting_power ORDER BY / WHERE.
-- voting_power is stored as TEXT to survive the JS Number precision cliff
-- (2^53) when aggregates approach total ADA supply. Individual DRep power
-- values fit in an INTEGER comfortably, and several hot queries filter or
-- sort by `CAST(voting_power AS INTEGER)`: the rationale fetch queue, the
-- action voters ranking, and the DRep sums powering the homepage rings.
--
-- SQLite indexes an expression when the query uses the same expression
-- textually. Indexing on CAST(voting_power AS INTEGER) lets the planner walk
-- dreps in power order without materializing and sorting the join result.
-- No schema change, no storage change; NULL power rows are simply absent
-- from the index and continue to sort last via the `IS NULL` clause.
CREATE INDEX IF NOT EXISTS idx_dreps_voting_power_int
  ON dreps (CAST(voting_power AS INTEGER) DESC);

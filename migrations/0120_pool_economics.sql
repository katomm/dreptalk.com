-- Pool distribution of the current epoch for the parameter change impact
-- panels. One row per epoch, only the newest is kept. Written by the gov-sync
-- phase `pool-economics` (the only Koios reader), read by both pool economics
-- routes. `body` is the JSON answer as served, `computed_at` is unix ms.
CREATE TABLE IF NOT EXISTS pool_economics (
  epoch INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);

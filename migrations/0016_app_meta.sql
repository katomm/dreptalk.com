-- Generic key/value metadata for the app, stored in D1. One row per key; values
-- are opaque strings (callers JSON-encode structured data). First use: the live
-- DRep voting thresholds pulled from Koios epoch_params during the DRep sync, so
-- the /dreps concentration view can show current, not hardcoded, thresholds.
CREATE TABLE app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

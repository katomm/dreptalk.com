-- Cached voting-power-origins analysis, one JSON payload per (drep, window).
-- Freshness is TTL-based on computed_at (checked by the API route, 3h), NOT
-- epoch-based: the page is about current composition and an epoch-long cache
-- could serve five-day-old data. Written only by /api/drep/voting-power-origins.
-- Contains aggregates and drep ids only, never stake addresses.
CREATE TABLE provenance_cache (
  drep_id TEXT NOT NULL,
  window_epochs INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (drep_id, window_epochs)
);

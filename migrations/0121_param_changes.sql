-- Change log of the Koios epoch_params fields, one row per field and epoch in
-- which its value changed (the first row of a field is its first non-null
-- value). Written by the gov-sync cron, read by the parameter change impact
-- panels to rebuild the parameters of a basis epoch. `value_json` is the
-- canonical JSON of the value, `gov_action_id` the enacted proposal that set it
-- when known.
CREATE TABLE IF NOT EXISTS param_changes (
  param_key TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  gov_action_id TEXT,
  PRIMARY KEY (param_key, epoch)
);
CREATE INDEX IF NOT EXISTS idx_param_changes_epoch ON param_changes (epoch);

-- Single row: the last epoch the log has been brought up to.
CREATE TABLE IF NOT EXISTS param_log_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_epoch INTEGER NOT NULL
);

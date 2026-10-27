import type { Budget } from 'drep-groups';

export const DEPTH = 10;
export const REG_OVERLAP_SECONDS = 3600;
export const DISCOVERY_PAGES_PER_RUN = 2;
export const MAX_NEW_TXS_PER_RUN = 500;
export const DISCOVERY_MAX_STATEMENTS = 120; // per stored block batch, the scan always finishes its block
export const MAX_GATE_CHECKS_PER_RUN = 2000;
export const HISTORY_BATCH = 50;
export const MAX_HISTORY_BATCHES_PER_RUN = 2;
export const MAX_SOLO_HISTORIES_PER_RUN = 5;
export const MAX_REG_PAGES_PER_RUN = 10;
export const MAX_ROLLBACK_PROBES_PER_RUN = 20;
export const MAX_SCRIPT_SEARCH_ROWS_PER_RUN = 50;
export const MAX_SCRIPT_SEARCH_FETCHES_PER_RUN = 25;
export const WITNESS_BACKOFF_BASE_MS = 900_000;
export const WITNESS_BACKOFF_MAX_MS = 86_400_000;
export const MARKER_REFETCH_PER_RUN = 100;
export const MARKER_REFETCH_ATTEMPTS = 5;
export const MAX_SCRIPT_DISPLAY_DEPTH = 32;
export const ENGINE_BUDGET: Budget = {
  controlTxs: 2,
  controlBytes: 65_536,
  credentialUnits: 8,
  credentialInputs: 32,
  truncateRows: 400,
  resetRows: 400,
};
// guard 2 + meta row 1 + (max CHANGES_PER_ROW 4 - 1): a budget 1 call changes 4 + 3 = 7 = 1 + 6
export const RECOVERY_STEP_OVERHEAD = 6;
// state, undo: row + recompute job + gen. versions: group row (gen inside) + recompute job + profile and website due rows,
// or for a deleted group its row + two due rows + trim due row. credentials: tracked row (gen inside) + repair job.
export const CHANGES_PER_ROW = {
  raw: 2,
  state: 3,
  undo: 3,
  versions: 4,
  credentials: 2,
  jobs: 1,
  flags: 2,
  reset: 2,
} as const;
export const COMMIT_MAX_STATEMENTS = 150; // worst case of one commit
export const RUN_MAX_QUERIES = 400; // worst case of one runEngine call
export const MAX_ENGINE_RUNS_PER_TICK = 10;
export const MAX_JOB_ROWS_PER_RUN = 200;
export const JOB_MAX_QUERIES = 40;
export const POWER_SCAN_PAGE = 100;
// worst case 18: lease batch 3, meta read 1, operator open and clear batch 5, version batch 5, power queue check 1,
// power-scan enqueue batch 3, plus margin 6
export const ADMIN_RESERVE_QUERIES = 24;
export const RELEASE_RESERVE_QUERIES = 2;
export const PROFILE_SELECT_QUERIES = 1; // the due selection, reserved before any item
export const WEBSITE_SELECT_QUERIES = 1;
export const PROFILE_QUERIES_PER_ITEM = 6; // guard, upsert, due delete, website due upsert, guard end, one anchor cache read
export const WEBSITE_QUERIES_PER_ITEM = 4; // guard, check update, due update, guard end
export const INGEST_QUERY_SHARE = 250;
export const GROUPS_QUERY_SHARE = 700; // admin + ingest + one worst case run + jobs + release
export const GOVERNANCE_QUERY_BUDGET = 900;
export const LEASE_MS = 900_000;
export const RETENTION_KEEP_APPLIED = 200;
export const RETENTION_KEEP_NOT_APPLIED = 50;
export const LISTED_MIN_MEMBERS = 2;
export const GROUP_PAGE_SIZE = 50;
export const PENDING_INDICATOR_CAP = 100;

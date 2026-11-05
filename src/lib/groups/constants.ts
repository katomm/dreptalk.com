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
/** Stored txs per run that get the block time they were stored without, one Koios call. */
export const TX_TIME_BACKFILL_PER_RUN = 50;
export const MAX_SCRIPT_DISPLAY_DEPTH = 32;
export const ENGINE_BUDGET: Budget = {
  controlTxs: 2,
  controlBytes: 65_536,
  credentialUnits: 8,
  credentialInputs: 32,
  truncateRows: 400,
  resetRows: 400,
};
// Rows written by one recovery call beyond its budget: guard 2 + meta row 1 + (max CHANGES_PER_ROW 11 - 1), the first
// page of a call takes one row even when the budget is smaller than its cost.
export const RECOVERY_STEP_OVERHEAD = 13;
// Worst case D1 rows_written per source row of each phase, trigger rows included. An insert counts its row and
// every index entry, a delete 1, an update its row and the index entries it inserts, an ignored insert 1.
// raw: the row and the pending_witness trigger. state: the row, a new recompute job (5) and the group's gen, more
// than an outcome or join request delete (1) or a reopened resolution (the row and its open control and unresolved
// entries, 3).
// undo: the instance, a new recompute job and gen. versions: the group row with its cur_h entry (2), a new
// recompute job (5), a new profile due row (3) and the website due delete, or for a deleted group its row, two due
// rows and the trim due row. credentials: the tracked row with its retired_at_h entry (2) and a new repair job (5).
// jobs: the job row. flags: closing or a new power job. markers: the flagged row and its refetch entry.
export const CHANGES_PER_ROW = {
  raw: 3,
  state: 7,
  undo: 7,
  versions: 11,
  credentials: 7,
  jobs: 1,
  flags: 5,
  markers: 2,
} as const;
export const RUN_MAX_QUERIES = 400; // worst case of one runEngine call
export const MAX_ENGINE_RUNS_PER_TICK = 10;
export const MAX_JOB_ROWS_PER_RUN = 200;
export const JOB_MAX_QUERIES = 40;
export const POWER_SCAN_PAGE = 100;
// worst case 18: lease batch 3, meta read 1, operator open and clear batch 5, version batch 5, power queue check 1,
// power-scan enqueue batch 3, plus margin 6
export const ADMIN_RESERVE_QUERIES = 24;
export const RELEASE_RESERVE_QUERIES = 2;
// The due selection, reserved before any item: one lease checked batch of guard, page, stale drop, guard end.
export const PROFILE_SELECT_QUERIES = 4;
export const WEBSITE_SELECT_QUERIES = 4;
export const PROFILE_QUERIES_PER_ITEM = 6; // guard, upsert, due delete, website due upsert, guard end, one anchor cache read
export const WEBSITE_QUERIES_PER_ITEM = 4; // guard, check update, due update, guard end
export const INGEST_QUERY_SHARE = 250;
export const GROUPS_QUERY_SHARE = 716; // admin + ingest + one worst case run + jobs + release
export const GOVERNANCE_QUERY_BUDGET = 900;
export const LEASE_MS = 900_000;
export const RETENTION_KEEP_APPLIED = 200;
export const RETENTION_KEEP_NOT_APPLIED = 50;
export const LISTED_MIN_MEMBERS = 2;
export const PROFILE_MIN_MEMBERS = 1;
export const ACTION_TTL_SECONDS = 172_800;
export const RESOLVE_ROWS_PER_TICK = 50;
export const RESOLVE_KOIOS_PER_TICK = 10;
/** Open group rows whose fee inputs a new action is checked against, far above what is open at once. */
export const OPEN_INPUT_ROWS = 500;
export const JOIN_NOTIFY_PER_TICK = 50;
export const PROFILE_DOC_MAX_BYTES = 16_384;
export const PROFILE_DOC_GRACE_MS = 7 * 86_400_000;
// Resolved group and member rows of the signing table are deleted this long after resolved_at,
// at most GROUP_ACTION_PRUNE_PER_RUN per run. Open rows stay.
export const GROUP_ACTION_RETENTION_MS = 90 * 86_400_000;
export const GROUP_ACTION_PRUNE_PER_RUN = 500;
export const PROFILE_DOC_RATE = { max: 10, windowSec: 60 };
export const ACTION_RATE = { max: 20, windowSec: 300 };
export const WITNESS_FEE_BYTES = 101; // one vkey witness in the witness set
export const GROUP_JSONLD_CONTEXT = 'https://github.com/katomm/cardano-drep-groups/blob/main/context/drep-groups-v1.jsonld';
export const GROUP_PAGE_SIZE = 50;
export const PENDING_INDICATOR_CAP = 100;
export const WEBSITE_RECHECK_MS = 86_400_000;
export const PROFILE_RETRY_MS = 6 * 3_600_000;
export const WELL_KNOWN_MAX_BYTES = 64 * 1024;
/** Where the DRep groups standard is published. Points to the library until the CIP pull request exists. */
export const DREP_GROUPS_STANDARD_URL = 'https://github.com/katomm/cardano-drep-groups';

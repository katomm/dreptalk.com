/// <reference types="@cloudflare/workers-types" />
import { epochFromUnix, type NetworkConfig } from '../config/network.js';
import { chunked } from '../db/sql.js';
import { getParamLogState, loadLatestParamValues } from '../db/paramLog.js';
import { diffEpochParams, payloadKoiosFields } from './paramLog.js';
import { parameterChangeMap } from './onchain.js';

/** Epochs read from Koios per run. A longer backlog is worked off over several runs. */
export const PARAM_LOG_BATCH = 50;

export interface ParamLogKoios {
  epochParamsAfter(afterEpoch: number, limit: number): Promise<Record<string, unknown>[]>;
}

// D1 allows 100 bound parameters per statement, an insert binds 3.
const INSERT_SQL = 'INSERT OR IGNORE INTO param_changes (param_key, epoch, value_json) VALUES (?, ?, ?)';

/**
 * The contiguous run of rows that follows `after`, or null when the answer is
 * malformed (a row without a numeric epoch_no, or epochs not ascending). A gap is
 * not malformed, the run just ends before it.
 */
function contiguousRun(rows: Record<string, unknown>[], after: number): { epoch: number; row: Record<string, unknown> }[] | null {
  const run: { epoch: number; row: Record<string, unknown> }[] = [];
  let prev = -Infinity;
  let expected = after >= 0 ? after + 1 : null;
  let ended = false;
  for (const row of rows) {
    const epoch = row.epoch_no;
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch <= prev) return null;
    prev = epoch;
    if (!ended && (expected === null || epoch === expected)) {
      run.push({ epoch, row });
      expected = epoch + 1;
    } else {
      ended = true;
    }
  }
  return run;
}

/** Sets gov_action_id on log rows that an enacted ParameterChange wrote. Returns the rows linked. */
async function linkEnactedActions(db: D1Database): Promise<number> {
  const bound = await db
    .prepare("SELECT MIN(enacted_epoch) AS lo FROM governance_actions WHERE type = 'ParameterChange' AND enacted_epoch IS NOT NULL")
    .first<{ lo: number | null }>();
  if (bound?.lo == null) return 0;
  const { results: open } = await db
    .prepare('SELECT DISTINCT epoch FROM param_changes WHERE gov_action_id IS NULL AND epoch >= ?')
    .bind(bound.lo)
    .all<{ epoch: number }>();
  if (open.length === 0) return 0;
  const openEpochs = new Set(open.map((r) => r.epoch));
  const { results: actions } = await db
    .prepare(
      "SELECT id, enacted_epoch, onchain_payload FROM governance_actions WHERE type = 'ParameterChange' AND enacted_epoch IS NOT NULL ORDER BY enacted_epoch, id",
    )
    .all<{ id: string; enacted_epoch: number; onchain_payload: string | null }>();
  const stmts: D1PreparedStatement[] = [];
  for (const a of actions) {
    if (!openEpochs.has(a.enacted_epoch)) continue;
    const map = parameterChangeMap(a.onchain_payload);
    if (!map) continue;
    const fields = new Set(Object.keys(map).flatMap(payloadKoiosFields));
    for (const field of fields) {
      stmts.push(
        db
          .prepare('UPDATE param_changes SET gov_action_id = ? WHERE param_key = ? AND epoch = ? AND gov_action_id IS NULL')
          .bind(a.id, field, a.enacted_epoch),
      );
    }
  }
  let linked = 0;
  for (const batch of chunked(stmts, 50)) {
    for (const r of await db.batch(batch)) linked += r.meta.changes ?? 0;
  }
  return linked;
}

/**
 * Extends the parameter change log by the epochs Koios has beyond the log state, then
 * links the rows an enacted ParameterChange wrote to that proposal. One Koios read per
 * call, so a long backlog is worked off over several runs. No Koios read when the log
 * is already at the clock's epoch.
 */
export async function syncParamLog(args: {
  db: D1Database;
  koios: ParamLogKoios;
  cfg: NetworkConfig;
  now: number;
}): Promise<{ fromEpoch: number | null; toEpoch: number | null; inserted: number; linked: number }> {
  const { db, koios, cfg, now } = args;
  const state = await getParamLogState(db);
  const after = state ?? -1;
  const caughtUp = state === epochFromUnix(Math.floor(now / 1000), cfg);
  const run = caughtUp ? null : contiguousRun(await koios.epochParamsAfter(after, PARAM_LOG_BATCH), after);

  let fromEpoch: number | null = null;
  let toEpoch: number | null = null;
  let inserted = 0;
  if (run && run.length > 0) {
    const latest = await loadLatestParamValues(db);
    const stmts: D1PreparedStatement[] = [];
    for (const { epoch, row } of run) {
      for (const c of diffEpochParams(latest, row)) {
        stmts.push(db.prepare(INSERT_SQL).bind(c.paramKey, epoch, c.valueJson));
        latest.set(c.paramKey, c.valueJson);
      }
    }
    fromEpoch = run[0].epoch;
    toEpoch = run[run.length - 1].epoch;
    stmts.push(
      db
        .prepare('INSERT INTO param_log_state (id, last_epoch) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_epoch = excluded.last_epoch')
        .bind(toEpoch),
    );
    inserted = stmts.length - 1;
    await db.batch(stmts);
  }

  const linked = await linkEnactedActions(db);
  return { fromEpoch, toEpoch, inserted, linked };
}

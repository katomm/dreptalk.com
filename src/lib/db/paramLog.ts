/// <reference types="@cloudflare/workers-types" />
import { paramRowFromLog } from '../governance/paramLog.js';

/** The last epoch the parameter log has been brought up to, null before the first run. */
export async function getParamLogState(db: D1Database): Promise<number | null> {
  const row = await db.prepare('SELECT last_epoch FROM param_log_state WHERE id = 1').first<{ last_epoch: number }>();
  return row?.last_epoch ?? null;
}

/** The newest logged value of every parameter key (param key to value_json). */
export async function loadLatestParamValues(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT p.param_key, p.value_json FROM param_changes p
       WHERE p.epoch = (SELECT MAX(epoch) FROM param_changes WHERE param_key = p.param_key)`,
    )
    .all<{ param_key: string; value_json: string }>();
  return new Map(results.map((r) => [r.param_key, r.value_json]));
}

/**
 * The epoch_params-shaped row in force at `epoch`, rebuilt from the log. Null when
 * the log does not reach that epoch yet (no state or `epoch` beyond it), so a caller
 * never shows current data for a past epoch.
 */
export async function paramRowAsOf(db: D1Database, epoch: number): Promise<Record<string, unknown> | null> {
  const [last, { results }] = await Promise.all([
    getParamLogState(db),
    db
      .prepare(
        `SELECT p.param_key, p.value_json FROM param_changes p
       WHERE p.epoch = (SELECT MAX(epoch) FROM param_changes WHERE param_key = p.param_key AND epoch <= ?1)`,
      )
      .bind(epoch)
      .all<{ param_key: string; value_json: string }>(),
  ]);
  if (last === null || epoch > last) return null;
  return paramRowFromLog(results.map((r) => ({ paramKey: r.param_key, valueJson: r.value_json })));
}

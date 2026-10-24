import { PARAM_REGISTRY, registryKey } from './onchain.js';

// epoch_params fields that are not protocol parameters.
export const PARAM_LOG_EXCLUDED: readonly string[] = ['epoch_no', 'era', 'nonce', 'block_hash', 'extra_entropy'];

// Payload keys whose registry entry has no single snake_case field, to the
// epoch_params fields they cover.
const EX_UNITS_FIELDS: Record<string, string[]> = {
  maxTxExecutionUnits: ['max_tx_ex_mem', 'max_tx_ex_steps'],
  maxBlockExecutionUnits: ['max_block_ex_mem', 'max_block_ex_steps'],
  executionUnitPrices: ['price_mem', 'price_step'],
};

const POOL_THRESHOLD_FIELDS = [
  'pvt_motion_no_confidence',
  'pvt_committee_normal',
  'pvt_committee_no_confidence',
  'pvt_hard_fork_initiation',
  'pvtpp_security_group',
];

const DREP_THRESHOLD_FIELDS = [
  'dvt_motion_no_confidence',
  'dvt_committee_normal',
  'dvt_committee_no_confidence',
  'dvt_update_to_constitution',
  'dvt_hard_fork_initiation',
  'dvt_p_p_network_group',
  'dvt_p_p_economic_group',
  'dvt_p_p_technical_group',
  'dvt_p_p_gov_group',
  'dvt_treasury_withdrawal',
];

function canonical(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : v;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/**
 * Canonical JSON of an epoch_params value. Keys are sorted recursively and whole
 * numbers are written as digit strings, so `2000000` and `'2000000'` (Koios sends
 * both) compare equal. Decimals stay numbers, undefined and null are 'null'.
 */
export function normalizeParamValue(v: unknown): string {
  return JSON.stringify(canonical(v));
}

/** The values of `row` that differ from `latest` (param key to its newest valueJson). */
export function diffEpochParams(
  latest: ReadonlyMap<string, string>,
  row: Record<string, unknown>,
): { paramKey: string; valueJson: string }[] {
  const changes: { paramKey: string; valueJson: string }[] = [];
  const keys = new Set(Object.keys(row).filter((k) => !PARAM_LOG_EXCLUDED.includes(k)));
  for (const k of latest.keys()) keys.add(k);
  for (const paramKey of keys) {
    const valueJson = normalizeParamValue(Object.hasOwn(row, paramKey) ? row[paramKey] : undefined);
    const prev = latest.get(paramKey);
    if (prev === undefined ? valueJson !== 'null' : prev !== valueJson) changes.push({ paramKey, valueJson });
  }
  return changes;
}

/** An epoch_params-shaped row from logged values. Null values are left out. */
export function paramRowFromLog(entries: readonly { paramKey: string; valueJson: string }[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const e of entries) {
    if (e.valueJson === 'null') continue;
    row[e.paramKey] = JSON.parse(e.valueJson);
  }
  return row;
}

/** The epoch_params fields a ParameterChange payload key covers. */
export function payloadKoiosFields(payloadKey: string): string[] {
  const rk = registryKey(payloadKey);
  const snake = Object.hasOwn(PARAM_REGISTRY, rk) ? PARAM_REGISTRY[rk].snake : '';
  if (snake) return [snake];
  if (Object.hasOwn(EX_UNITS_FIELDS, rk)) return [...EX_UNITS_FIELDS[rk]];
  if (rk === 'poolVotingThresholds') return [...POOL_THRESHOLD_FIELDS];
  if (rk === 'dRepVotingThresholds') return [...DREP_THRESHOLD_FIELDS];
  return [];
}

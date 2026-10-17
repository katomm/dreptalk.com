// Proposed values of a ParameterChange payload and the parameters that get an
// impact chart. Pure, no I/O.
import type { Rational } from '../format/rational.js';
import { PARAM_ALIASES, payloadRational, wholeAmount } from './onchain.js';
import { PARAM_DEFS, PARAM_KEYS, type ParamKey, type ParamValues } from './paramDefs.js';

// The pool model (modelParams) needs all four of these in force.
const MODEL_KEYS: readonly ParamKey[] = ['k', 'a0', 'rho', 'tau'];

/** The offered parameters a ParameterChange payload proposes. Unreadable values are left out. */
export function proposedParamValues(payloadJson: string | null): ParamValues {
  const out: ParamValues = {};
  if (!payloadJson) return out;
  let payload: { tag?: string; contents?: unknown[] };
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return out;
  }
  if (payload?.tag !== 'ParameterChange' || !Array.isArray(payload.contents)) return out;
  const map = payload.contents[1];
  if (!map || typeof map !== 'object') return out;
  for (const [payloadKey, raw] of Object.entries(map as Record<string, unknown>)) {
    const ledgerKey = PARAM_ALIASES[payloadKey] ?? payloadKey;
    const key = PARAM_KEYS.find((k) => PARAM_DEFS[k].ledgerKey === ledgerKey);
    if (!key) continue;
    const input = PARAM_DEFS[key].input;
    let value: Rational | null = null;
    if (input === 'int' || input === 'ada' || input === 'lovelace') {
      const s = wholeAmount(raw);
      if (s !== null) value = { n: BigInt(s), d: 1n };
    } else {
      value = payloadRational(raw);
    }
    if (value) out[key] = value;
  }
  return out;
}

/** The parameters that get an impact chart: offered, proposed and in force, and only while the action is active. */
export function impactSectionKeys(proposed: ParamValues, current: ParamValues, status: string): ParamKey[] {
  if (status !== 'active') return [];
  const hasModel = MODEL_KEYS.every((k) => current[k]);
  return PARAM_KEYS.filter((k) => proposed[k] && current[k] && (hasModel || !MODEL_KEYS.includes(k)));
}

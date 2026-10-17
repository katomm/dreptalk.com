// Proposed values of a ParameterChange payload and the parameters that get an
// impact chart. Pure, no I/O.
import type { Rational } from '../format/rational.js';
import { parameterChangeMap, payloadRational, registryKey, wholeAmount } from './onchain.js';
import {
  currentParamValues,
  PARAM_DEFS,
  PARAM_KEYS,
  valuesToJson,
  type ParamKey,
  type ParamValues,
} from './paramDefs.js';
import type { GaParamImpactProps } from '@/components/ga/GaParamImpact.js';
import type { CardanoNetwork } from '../config/network.js';

// The pool model (modelParams) needs all four of these in force.
const MODEL_KEYS: readonly ParamKey[] = ['k', 'a0', 'rho', 'tau'];

/** The offered parameters a ParameterChange payload proposes. Unreadable values are left out. */
export function proposedParamValues(payloadJson: string | null): ParamValues {
  const out: ParamValues = {};
  const map = parameterChangeMap(payloadJson);
  if (!map) return out;
  for (const [payloadKey, raw] of Object.entries(map)) {
    const ledgerKey = registryKey(payloadKey);
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

/**
 * The proposal page's impact section props for a ParameterChange, or null when
 * the action is not active or no offered parameter has both values. Reads no
 * JSON for a non-active action.
 */
export function buildParamImpact(
  payloadJson: string | null,
  rawJson: string | null,
  status: string,
  network: CardanoNetwork,
): GaParamImpactProps | null {
  if (status !== 'active') return null;
  let currentRow: Record<string, unknown> = {};
  try {
    currentRow = JSON.parse(rawJson ?? '{}') as Record<string, unknown>;
  } catch {
    currentRow = {};
  }
  const proposed = proposedParamValues(payloadJson);
  const current = currentParamValues(currentRow);
  const keys = impactSectionKeys(proposed, current, status);
  return keys.length > 0 ? { network, keys, current: valuesToJson(current), proposed: valuesToJson(proposed) } : null;
}

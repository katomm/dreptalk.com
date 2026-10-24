// Proposed values of a ParameterChange payload and the parameters that get an
// impact chart. Pure, no I/O.
import { equalRational, type Rational } from '../format/rational.js';
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
import type { ImpactOutcome } from './basisEpoch.js';

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

// The one status table: a status listed here gets an impact section.
const OUTCOMES: Record<string, ImpactOutcome> = { active: 'open', ratified: 'open', enacted: 'enacted', expired: 'ended', dropped: 'ended' };

/**
 * The parameters that get an impact chart: offered, proposed and in force. A
 * decided action also drops a key whose value already equals the proposal.
 */
export function impactSectionKeys(proposed: ParamValues, current: ParamValues, status: string): ParamKey[] {
  if (!Object.hasOwn(OUTCOMES, status)) return [];
  const hasModel = MODEL_KEYS.every((k) => current[k]);
  return PARAM_KEYS.filter((k) => {
    const p = proposed[k];
    const c = current[k];
    if (!p || !c || (MODEL_KEYS.includes(k) && !hasModel)) return false;
    return status === 'active' || !equalRational(p, c);
  });
}

/**
 * The proposal page's impact section props for a ParameterChange, or null when
 * the status is not covered, there is no row in force, or no offered parameter
 * has both values. Keys that need pool data are left out when none is stored.
 */
export function buildParamImpact(input: {
  payloadJson: string | null;
  status: string;
  currentRow: Record<string, unknown> | null;
  basisEpoch: number | null;
  poolDataStored: boolean;
  network: CardanoNetwork;
}): GaParamImpactProps | null {
  const { payloadJson, status, currentRow, network } = input;
  const outcome = OUTCOMES[status];
  if (!outcome || !currentRow) return null;
  const proposed = proposedParamValues(payloadJson);
  const current = currentParamValues(currentRow);
  const keys = impactSectionKeys(proposed, current, status).filter((k) => input.poolDataStored || !PARAM_DEFS[k].needsPoolData);
  return keys.length > 0
    ? { network, keys, current: valuesToJson(current), proposed: valuesToJson(proposed), basisEpoch: input.basisEpoch, outcome }
    : null;
}

/**
 * The parameter row in force for a ParameterChange page. A decided
 * ParameterChange uses its basis row, never today's parameters. Everything else
 * uses the current epoch parameters (an unreadable blob counts as empty).
 */
export function inForceRow(
  type: string | null | undefined,
  status: string,
  rawJson: string | null,
  basisRow: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (type === 'ParameterChange' && status !== 'active') return basisRow;
  if (rawJson === null) return null;
  try {
    return JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The old values JSON for the on-chain changes block, from the row in force. */
export function onchainOldValuesJson(
  type: string | null | undefined,
  status: string,
  basisRow: Record<string, unknown> | null,
  rawJson: string | null,
): string | null {
  const row = inForceRow(type, status, rawJson, basisRow);
  return row ? JSON.stringify(row) : null;
}

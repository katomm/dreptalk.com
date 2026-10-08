// The five staking parameters the submit form can change, as one table: the
// single source for the panel, the impact model, the evaluate route's check
// and the tests. Bounds are the constitution's guardrails
// (IntersectMBO/plutus cardano-constitution/data/defaultConstitution.json,
// keys "8", "9", "16", "10", "11", fetched 2026-10-07). The devnet test
// proves them against the deployed script, and where the two disagree the
// script wins. Leaf module, no SDK import.
import {
  compareRational,
  equalRational,
  formatLovelaceExact,
  formatRationalDecimal,
  formatRationalPercent,
  parseDecimal,
  rationalFromNumber,
  reduce,
  type Rational,
} from '../format/rational.js';
import type { ParamChangeScope } from './thresholds.js';

export type ParamKey = 'k' | 'a0' | 'minPoolCost' | 'rho' | 'tau';
export const PARAM_KEYS: readonly ParamKey[] = ['k', 'a0', 'minPoolCost', 'rho', 'tau'];
export type ParamValues = Partial<Record<ParamKey, Rational>>;

export interface ParamDef {
  key: ParamKey;
  /** The camelCase key in the on-chain payload (Koios proposal_description). */
  ledgerKey: 'stakePoolTargetNum' | 'poolPledgeInfluence' | 'minPoolCost' | 'monetaryExpansion' | 'treasuryCut';
  /** The field on the SDK's ProtocolParamUpdate. */
  sdkField: 'nOpt' | 'poolPledgeInfluence' | 'minPoolCost' | 'expansionRate' | 'treasuryGrowthRate';
  cddlKey: 8 | 9 | 16 | 10 | 11;
  group: 'technical' | 'economic';
  title: string;
  short: string;
  /** How the field is typed: a whole number, a decimal, ada, or percent. */
  input: 'int' | 'decimal' | 'ada' | 'percent';
  places: number;
  /** Bounds in the canonical unit: the integer, the rational, or lovelace. */
  min: Rational;
  max: Rational;
  /** The key in Koios /epoch_params. */
  koiosKey: 'optimal_pool_count' | 'influence' | 'min_pool_cost' | 'monetary_expand_rate' | 'treasury_growth_rate';
}

const q = (n: bigint, d = 1n): Rational => ({ n, d });

export const PARAM_DEFS: Record<ParamKey, ParamDef> = {
  k: {
    key: 'k', ledgerKey: 'stakePoolTargetNum', sdkField: 'nOpt', cddlKey: 8, group: 'technical',
    title: 'Target number of pools', short: 'k', input: 'int', places: 0,
    min: q(250n), max: q(2000n), koiosKey: 'optimal_pool_count',
  },
  a0: {
    key: 'a0', ledgerKey: 'poolPledgeInfluence', sdkField: 'poolPledgeInfluence', cddlKey: 9, group: 'technical',
    title: 'Pledge influence', short: 'a0', input: 'decimal', places: 3,
    min: q(1n, 10n), max: q(1n), koiosKey: 'influence',
  },
  minPoolCost: {
    key: 'minPoolCost', ledgerKey: 'minPoolCost', sdkField: 'minPoolCost', cddlKey: 16, group: 'economic',
    title: 'Minimum pool cost', short: 'minPoolCost', input: 'ada', places: 6,
    min: q(0n), max: q(500_000_000n), koiosKey: 'min_pool_cost',
  },
  rho: {
    key: 'rho', ledgerKey: 'monetaryExpansion', sdkField: 'expansionRate', cddlKey: 10, group: 'economic',
    title: 'Monetary expansion', short: 'rho', input: 'percent', places: 4,
    min: q(1n, 1000n), max: q(5n, 1000n), koiosKey: 'monetary_expand_rate',
  },
  tau: {
    key: 'tau', ledgerKey: 'treasuryCut', sdkField: 'treasuryGrowthRate', cddlKey: 11, group: 'economic',
    title: 'Treasury cut', short: 'tau', input: 'percent', places: 2,
    min: q(1n, 10n), max: q(3n, 10n), koiosKey: 'treasury_growth_rate',
  },
};

/** The DRep groups the offered parameters touch. None is security-relevant, so stake pools never vote. */
export const OFFERED_PARAM_SCOPE: ParamChangeScope = { groups: ['technical', 'economic'], touchesSecurity: false };

/** Scales a typed number into the canonical unit. */
function fromTyped(def: ParamDef, typed: Rational): Rational {
  if (def.input === 'ada') return reduce({ n: typed.n * 1_000_000n, d: typed.d });
  if (def.input === 'percent') return reduce({ n: typed.n, d: typed.d * 100n });
  return typed;
}

/** Parses what the user typed into the canonical value, or the sentence to show. */
export function parseParamInput(key: ParamKey, raw: string): { ok: true; value: Rational } | { ok: false; error: string } {
  const def = PARAM_DEFS[key];
  const parsed = parseDecimal(raw, def.places);
  if (!parsed.ok) {
    if (parsed.error === 'nan') return { ok: false, error: 'Enter a number.' };
    return { ok: false, error: def.places === 0 ? 'Enter a whole number.' : `Use at most ${def.places} decimal places.` };
  }
  const value = fromTyped(def, parsed.value);
  // Lovelace must be whole: six ada decimals always are, this guards the table.
  if (def.input === 'ada' && value.d !== 1n) return { ok: false, error: 'Use at most 6 decimal places.' };
  return { ok: true, value };
}

/** The canonical value in the form the panel prints it. Integers are grouped like the GA page prints them. */
export function formatParamValue(key: ParamKey, value: Rational): string {
  const def = PARAM_DEFS[key];
  if (def.input === 'ada') return formatLovelaceExact(value.n / value.d);
  if (def.input === 'percent') return formatRationalPercent(value);
  if (def.input === 'int') return (value.n / value.d).toLocaleString('en-US');
  return formatRationalDecimal(value);
}

/** The DRep groups a set of picked parameters touches. None is security-relevant. */
export function scopeForKeys(keys: readonly ParamKey[]): ParamChangeScope {
  const groups = [...new Set(keys.map((key) => PARAM_DEFS[key].group))];
  return { groups, touchesSecurity: false };
}

/**
 * The optional "Changes" paragraph for the abstract: one line per changed
 * parameter, old to new, with the constitution's range. Only ever added to the
 * abstract by an explicit click, and editable there before pinning.
 */
export function changesParagraph(next: ParamValues, current: ParamValues): string {
  const lines = PARAM_KEYS.flatMap((key) => {
    const to = next[key];
    const from = current[key];
    if (!to || !from) return [];
    const def = PARAM_DEFS[key];
    return [
      `- ${def.title} (${def.short}): ${formatParamValue(key, from)} to ${formatParamValue(key, to)}. The constitution allows ${formatParamValue(key, def.min)} to ${formatParamValue(key, def.max)}.`,
    ];
  });
  return lines.length ? `Changes:\n\n${lines.join('\n')}` : '';
}

/** The canonical value as the input field shows it (no unit, no grouping). */
export function inputFromValue(key: ParamKey, value: Rational): string {
  const def = PARAM_DEFS[key];
  if (def.input === 'ada') return formatRationalDecimal({ n: value.n, d: value.d * 1_000_000n });
  if (def.input === 'percent') return formatRationalDecimal({ n: value.n * 100n, d: value.d });
  return formatRationalDecimal(value);
}

/** The range error or the unchanged error for a parsed value, or null when the value can go on chain. */
export function checkParamValue(key: ParamKey, value: Rational, current: Rational | null): string | null {
  const def = PARAM_DEFS[key];
  if (compareRational(value, def.min) < 0 || compareRational(value, def.max) > 0) {
    return `The constitution allows ${formatParamValue(key, def.min)} to ${formatParamValue(key, def.max)}. The guardrails script would reject this action, so it cannot be submitted.`;
  }
  if (current && equalRational(value, current)) return `${def.title} has the same value as now. Change it or remove it.`;
  return null;
}

/** The parameters in force, from a Koios /epoch_params row. Missing or unreadable keys are left out. */
export function currentParamValues(row: Record<string, unknown> | null): ParamValues {
  const out: ParamValues = {};
  if (!row) return out;
  for (const key of PARAM_KEYS) {
    const raw = row[PARAM_DEFS[key].koiosKey];
    let value: Rational | null = null;
    if (typeof raw === 'number') value = rationalFromNumber(raw);
    else if (typeof raw === 'string' && /^\d+$/.test(raw)) value = { n: BigInt(raw), d: 1n };
    if (value) out[key] = value;
  }
  return out;
}

export type ParamValuesJson = Partial<Record<ParamKey, { n: string; d: string }>>;

export function valuesToJson(values: ParamValues): ParamValuesJson {
  const out: ParamValuesJson = {};
  for (const key of PARAM_KEYS) {
    const v = values[key];
    if (v) out[key] = { n: v.n.toString(), d: v.d.toString() };
  }
  return out;
}

export function valuesFromJson(json: ParamValuesJson | null | undefined): ParamValues {
  const out: ParamValues = {};
  for (const key of PARAM_KEYS) {
    const v = json?.[key];
    if (v && /^-?\d+$/.test(v.n) && /^\d+$/.test(v.d) && v.d !== '0') out[key] = reduce({ n: BigInt(v.n), d: BigInt(v.d) });
  }
  return out;
}

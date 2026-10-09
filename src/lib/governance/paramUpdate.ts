// The SDK side of the parameter table: ParamValues to a ProtocolParamUpdate
// with exactly the picked fields, and back. parseParamUpdate is also the
// evaluate route's check that a transaction proposes nothing DRepTalk does
// not offer.
import { CBOR, NonnegativeInterval, ProtocolParamUpdate, UnitInterval } from '@evolution-sdk/evolution';
import { reduce, type Rational } from '../format/rational.js';
import { PARAM_DEFS, PARAM_KEYS, checkParamValue, type ParamKey, type ParamValues } from './paramDefs.js';

const BY_SDK_FIELD = new Map<string, ParamKey>(PARAM_KEYS.map((key) => [PARAM_DEFS[key].sdkField, key]));

export function buildParamUpdate(values: ParamValues): ProtocolParamUpdate.ProtocolParamUpdate {
  const fields: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) {
    const v = values[key];
    if (!v) continue;
    const { n, d } = reduce(v);
    switch (PARAM_DEFS[key].sdkField) {
      case 'nOpt':
      case 'minPoolCost':
        if (d !== 1n) throw new Error(`${PARAM_DEFS[key].title} must be a whole number.`);
        fields[PARAM_DEFS[key].sdkField] = n;
        break;
      case 'poolPledgeInfluence':
        fields.poolPledgeInfluence = new NonnegativeInterval.NonnegativeInterval({ numerator: n, denominator: d });
        break;
      case 'expansionRate':
      case 'treasuryGrowthRate':
        fields[PARAM_DEFS[key].sdkField] = new UnitInterval.UnitInterval({ numerator: n, denominator: d });
        break;
    }
  }
  if (Object.keys(fields).length === 0) throw new Error('A parameter change needs at least one parameter.');
  return new ProtocolParamUpdate.ProtocolParamUpdate(fields as ConstructorParameters<typeof ProtocolParamUpdate.ProtocolParamUpdate>[0]);
}

function rationalOf(value: unknown): Rational | null {
  if (typeof value === 'bigint') return { n: value, d: 1n };
  if (typeof value === 'number' && Number.isSafeInteger(value)) return { n: BigInt(value), d: 1n };
  if (value && typeof value === 'object' && 'numerator' in value && 'denominator' in value) {
    const { numerator, denominator } = value as { numerator: unknown; denominator: unknown };
    if (typeof numerator === 'bigint' && typeof denominator === 'bigint' && denominator > 0n) {
      return reduce({ n: numerator, d: denominator });
    }
  }
  return null;
}

/** The five values an update sets, or why the update is not one DRepTalk offers. */
export function parseParamUpdate(
  update: ProtocolParamUpdate.ProtocolParamUpdate,
): { ok: true; values: ParamValues } | { ok: false; reason: 'empty' | 'foreign_key' | 'out_of_range'; field?: string } {
  const values: ParamValues = {};
  for (const [field, value] of Object.entries(update)) {
    if (field === '_tag' || value === undefined) continue;
    const key = BY_SDK_FIELD.get(field);
    if (!key) return { ok: false, reason: 'foreign_key', field };
    const q = rationalOf(value);
    if (!q || checkParamValue(key, q, null) !== null) return { ok: false, reason: 'out_of_range', field };
    values[key] = q;
  }
  if (Object.keys(values).length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, values };
}

/** The CDDL keys a parameter change update may set. */
export const OFFERED_CDDL_KEYS: ReadonlySet<number> = new Set(PARAM_KEYS.map((key) => PARAM_DEFS[key].cddlKey));

const untag = (v: CBOR.CBOR): CBOR.CBOR =>
  v !== null && typeof v === 'object' && '_tag' in v && v._tag === 'Tag' ? (v as { value: CBOR.CBOR }).value : v;

/**
 * The parameter update keys of every ParameterChange in a transaction, read
 * from the raw CBOR (body key 20, proposal procedures, each action
 * [0, prev, update, policy]). Null when the bytes do not have that shape.
 */
export function paramUpdateKeysInTx(txCborHex: string): number[][] | null {
  try {
    const tx = CBOR.fromCBORHex(txCborHex);
    if (!Array.isArray(tx)) return null;
    const body = tx[0];
    if (!(body instanceof Map)) return null;
    const procedures = untag(body.get(20n) ?? null);
    if (procedures === null || procedures === undefined) return [];
    if (!Array.isArray(procedures)) return null;
    const out: number[][] = [];
    for (const procedure of procedures) {
      if (!Array.isArray(procedure)) return null;
      const action = procedure[2];
      if (!Array.isArray(action) || action[0] !== 0n) continue;
      const update = action[2];
      if (!(update instanceof Map)) return null;
      out.push([...update.keys()].map((key) => Number(key)));
    }
    return out;
  } catch {
    return null;
  }
}

// src/lib/governance/paramDefs.test.ts
import { describe, it, expect } from 'vitest';
import {
  PARAM_DEFS,
  PARAM_KEYS,
  changesParagraph,
  checkParamValue,
  currentParamValues,
  scopeForKeys,
  formatParamValue,
  inputFromValue,
  parseParamInput,
  valuesFromJson,
  valuesToJson,
} from './paramDefs.js';
const r = (n: bigint, d: bigint) => ({ n, d });

// The five entries of IntersectMBO/plutus cardano-constitution/data/defaultConstitution.json
// (fetched 2026-10-07) that the table copies, predicates verbatim minus the comments.
const GUARDRAIL_CONFIG: Record<string, { predicates: Record<string, unknown>[] }> = {
  '8': { predicates: [{ minValue: 250 }, { maxValue: 2000 }, { minValue: 0 }, { notEqual: 0 }] },
  '9': {
    predicates: [
      { minValue: { numerator: 1, denominator: 10 } },
      { maxValue: { numerator: 10, denominator: 10 } },
      { minValue: { numerator: 0, denominator: 10 } },
    ],
  },
  '10': {
    predicates: [
      { maxValue: { numerator: 5, denominator: 1000 } },
      { minValue: { numerator: 1, denominator: 1000 } },
      { minValue: { numerator: 0, denominator: 1000 } },
    ],
  },
  '11': {
    predicates: [
      { minValue: { numerator: 10, denominator: 100 } },
      { maxValue: { numerator: 30, denominator: 100 } },
      { minValue: { numerator: 0, denominator: 100 } },
      { maxValue: { numerator: 100, denominator: 100 } },
    ],
  },
  '16': { predicates: [{ minValue: 0 }, { maxValue: 500000000 }] },
};

describe('PARAM_DEFS', () => {
  it('matches the guardrail configuration bounds', () => {
    // Integers and coin as numbers, intervals as { numerator, denominator }.
    const asRational = (v: unknown) =>
      typeof v === 'number' ? r(BigInt(v), 1n) : r(BigInt((v as { numerator: number }).numerator), BigInt((v as { denominator: number }).denominator));
    for (const key of PARAM_KEYS) {
      const def = PARAM_DEFS[key];
      const entry = GUARDRAIL_CONFIG[String(def.cddlKey)];
      const mins = entry.predicates.flatMap((p) => ('minValue' in p ? [asRational(p.minValue)] : []));
      const maxs = entry.predicates.flatMap((p) => ('maxValue' in p ? [asRational(p.maxValue)] : []));
      const tightestMin = mins.reduce((a, b) => (a.n * b.d >= b.n * a.d ? a : b));
      const tightestMax = maxs.reduce((a, b) => (a.n * b.d <= b.n * a.d ? a : b));
      expect([key, def.min.n * tightestMin.d]).toEqual([key, tightestMin.n * def.min.d]);
      expect([key, def.max.n * tightestMax.d]).toEqual([key, tightestMax.n * def.max.d]);
    }
  });
});

describe('parseParamInput', () => {
  it('reads each input kind into its canonical unit', () => {
    expect(parseParamInput('k', '600')).toEqual({ ok: true, value: r(600n, 1n) });
    expect(parseParamInput('a0', '0,35')).toEqual({ ok: true, value: r(7n, 20n) });
    expect(parseParamInput('minPoolCost', '170.000001')).toEqual({ ok: true, value: r(170000001n, 1n) });
    expect(parseParamInput('rho', '0.35')).toEqual({ ok: true, value: r(7n, 2000n) });
    expect(parseParamInput('tau', '25')).toEqual({ ok: true, value: r(1n, 4n) });
  });
  it('words the input errors', () => {
    expect(parseParamInput('k', '600.5')).toEqual({ ok: false, error: 'Enter a whole number.' });
    expect(parseParamInput('a0', '0.3501')).toEqual({ ok: false, error: 'Use at most 3 decimal places.' });
    expect(parseParamInput('a0', '0.35%')).toEqual({ ok: false, error: 'Enter a number.' });
    expect(parseParamInput('tau', '')).toEqual({ ok: false, error: 'Enter a number.' });
  });
});

describe('checkParamValue', () => {
  const cases: [string, string, boolean][] = [
    ['k', '250', true], ['k', '2000', true], ['k', '249', false], ['k', '2001', false],
    ['a0', '0.1', true], ['a0', '1', true], ['a0', '0.099', false], ['a0', '1.001', false],
    ['minPoolCost', '0', true], ['minPoolCost', '500', true], ['minPoolCost', '500.000001', false],
    ['rho', '0.1', true], ['rho', '0.5', true], ['rho', '0.0999', false], ['rho', '0.5001', false],
    ['tau', '10', true], ['tau', '30', true], ['tau', '9.99', false], ['tau', '30.01', false],
  ];
  it.each(cases)('%s %s within bounds: %s', (key, raw, ok) => {
    const parsed = parseParamInput(key as never, raw);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(checkParamValue(key as never, parsed.value, null) === null).toBe(ok);
  });
  it('words the range error with the allowed span', () => {
    expect(checkParamValue('tau', r(7n, 20n), null)).toBe(
      'The constitution allows 10% to 30%. The guardrails script would reject this action, so it cannot be submitted.',
    );
    expect(checkParamValue('minPoolCost', r(500000001n, 1n), null)).toBe(
      'The constitution allows 0 ₳ to 500 ₳. The guardrails script would reject this action, so it cannot be submitted.',
    );
  });
  it('refuses a value equal to the one in force', () => {
    expect(checkParamValue('k', r(500n, 1n), r(500n, 1n))).toBe(
      'Target number of pools has the same value as now. Change it or remove it.',
    );
    expect(checkParamValue('a0', r(3n, 10n), r(30n, 100n))).not.toBeNull();
  });
});

describe('scope and changes paragraph', () => {
  it('derives the touched groups from the picked parameters', () => {
    expect(scopeForKeys(['minPoolCost'])).toEqual({ groups: ['economic'], touchesSecurity: false });
    expect(scopeForKeys(['k', 'tau'])).toEqual({ groups: ['technical', 'economic'], touchesSecurity: false });
  });
  it('writes one line per changed parameter with its range', () => {
    expect(changesParagraph({ k: r(600n, 1n), tau: r(1n, 4n) }, { k: r(500n, 1n), tau: r(1n, 5n) })).toBe(
      'Changes:\n\n- Target number of pools (k): 500 to 600. The constitution allows 250 to 2,000.\n- Treasury cut (tau): 20% to 25%. The constitution allows 10% to 30%.',
    );
    expect(changesParagraph({}, {})).toBe('');
  });
});

describe('display', () => {
  it('groups integers like the GA page', () => {
    expect(formatParamValue('k', r(2000n, 1n))).toBe('2,000');
    expect(inputFromValue('k', r(2000n, 1n))).toBe('2000');
    expect(checkParamValue('k', r(2001n, 1n), null)).toBe(
      'The constitution allows 250 to 2,000. The guardrails script would reject this action, so it cannot be submitted.',
    );
  });
  it('formats each parameter losslessly', () => {
    expect(formatParamValue('k', r(600n, 1n))).toBe('600');
    expect(formatParamValue('a0', r(7n, 20n))).toBe('0.35');
    expect(formatParamValue('minPoolCost', r(170000001n, 1n))).toBe('170.000001 ₳');
    expect(formatParamValue('rho', r(3001n, 1000000n))).toBe('0.3001%');
    expect(formatParamValue('tau', r(1n, 4n))).toBe('25%');
  });
  it('turns a value back into what the input shows', () => {
    expect(inputFromValue('minPoolCost', r(170000000n, 1n))).toBe('170');
    expect(inputFromValue('rho', r(3n, 1000n))).toBe('0.3');
    expect(inputFromValue('tau', r(1n, 5n))).toBe('20');
  });
});

describe('currentParamValues', () => {
  it('reads the five keys from an epoch_params row', () => {
    expect(
      currentParamValues({
        optimal_pool_count: 500,
        influence: 0.3,
        min_pool_cost: '170000000',
        monetary_expand_rate: 0.003,
        treasury_growth_rate: 0.2,
      }),
    ).toEqual({ k: r(500n, 1n), a0: r(3n, 10n), minPoolCost: r(170000000n, 1n), rho: r(3n, 1000n), tau: r(1n, 5n) });
  });
  it('leaves out what is missing or unreadable, and keeps a repeating float as printed', () => {
    const values = currentParamValues({ influence: 0.3333333333333333, min_pool_cost: 'abc' });
    expect(Object.keys(values)).toEqual(['a0']);
    expect(currentParamValues(null)).toEqual({});
  });
  it('round-trips through JSON', () => {
    const v = { k: r(600n, 1n), rho: r(7n, 2000n) };
    expect(valuesFromJson(JSON.parse(JSON.stringify(valuesToJson(v))))).toEqual(v);
  });
});

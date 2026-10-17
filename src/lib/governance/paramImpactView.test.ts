import { describe, expect, it } from 'vitest';
import { buildParamImpact, impactSectionKeys, proposedParamValues } from './paramImpactView.js';
import type { ParamValues } from './paramDefs.js';

const payload = (map: Record<string, unknown>) => JSON.stringify({ tag: 'ParameterChange', contents: [null, map, null] });
const r = (n: bigint, d = 1n) => ({ n, d });

describe('proposedParamValues', () => {
  it('reads whole numbers from numbers and digit strings', () => {
    expect(proposedParamValues(payload({ stakePoolTargetNum: 600 })).k).toEqual(r(600n));
    expect(proposedParamValues(payload({ stakePoolTargetNum: '600' })).k).toEqual(r(600n));
    expect(proposedParamValues(payload({ minPoolCost: 170000000 })).minPoolCost).toEqual(r(170000000n));
    expect(proposedParamValues(payload({ minPoolCost: '170000000' })).minPoolCost).toEqual(r(170000000n));
    expect(proposedParamValues(payload({ utxoCostPerByte: 3000 })).utxoCostPerByte).toEqual(r(3000n));
  });

  it('reads rationals from decimals and numerator/denominator', () => {
    expect(proposedParamValues(payload({ poolPledgeInfluence: 0.35 })).a0).toEqual(r(7n, 20n));
    expect(proposedParamValues(payload({ poolPledgeInfluence: { numerator: 7, denominator: 20 } })).a0).toEqual(r(7n, 20n));
    expect(proposedParamValues(payload({ monetaryExpansion: 0.003001 })).rho).toEqual(r(3001n, 1000000n));
    expect(proposedParamValues(payload({ treasuryCut: { numerator: 1, denominator: 4 } })).tau).toEqual(r(1n, 4n));
  });

  it('resolves the old alias name', () => {
    expect(proposedParamValues(payload({ coinsPerUTxOByte: 3000 })).utxoCostPerByte).toEqual(r(3000n));
  });

  it('leaves out unreadable values', () => {
    expect(proposedParamValues(payload({ stakePoolTargetNum: 'abc' }))).toEqual({});
    expect(proposedParamValues(payload({ minPoolCost: -1 }))).toEqual({});
    expect(proposedParamValues(payload({ treasuryCut: { numerator: 1, denominator: 0 } }))).toEqual({});
  });

  it('gives {} for other payloads', () => {
    expect(proposedParamValues(JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [null, { a: 1 }, null] }))).toEqual({});
    expect(proposedParamValues(JSON.stringify({ tag: 'ParameterChange', contents: [null] }))).toEqual({});
    expect(proposedParamValues(null)).toEqual({});
    expect(proposedParamValues('not json')).toEqual({});
  });
});

describe('impactSectionKeys', () => {
  const current: ParamValues = { k: r(500n), a0: r(3n, 10n), rho: r(3n, 1000n), tau: r(2n, 10n), minPoolCost: r(170000000n), utxoCostPerByte: r(4310n) };
  const proposed: ParamValues = { k: r(600n), minPoolCost: r(1n), utxoCostPerByte: r(3000n), tau: r(1n, 4n) };

  it('is empty unless the action is active', () => {
    for (const s of ['pending', 'enacted', 'expired', 'dropped', 'ratified']) {
      expect(impactSectionKeys(proposed, current, s)).toEqual([]);
    }
  });

  it('follows PARAM_KEYS order and needs both values', () => {
    expect(impactSectionKeys(proposed, current, 'active')).toEqual(['k', 'minPoolCost', 'tau', 'utxoCostPerByte']);
    expect(impactSectionKeys({}, current, 'active')).toEqual([]);
    expect(impactSectionKeys(proposed, { k: r(500n), a0: r(3n, 10n), rho: r(3n, 1000n), tau: r(2n, 10n) }, 'active')).toEqual(['k', 'tau']);
  });

  it('drops the pool-model keys when the current set lacks one of the four', () => {
    const { a0: _a0, ...noA0 } = current;
    expect(impactSectionKeys({ k: r(600n), minPoolCost: r(1n) }, noA0, 'active')).toEqual(['minPoolCost']);
  });
});

describe('buildParamImpact', () => {
  const onchain = payload({ utxoCostPerByte: 3000 });
  const raw = JSON.stringify({ coins_per_utxo_size: 4310 });

  it('returns null for a non-active action without reading the JSON', () => {
    expect(buildParamImpact(onchain, '{not json', 'ratified', 'preprod')).toBeNull();
    expect(buildParamImpact(onchain, raw, 'expired', 'preprod')).toBeNull();
  });

  it('returns null when the in force row is not valid JSON', () => {
    expect(buildParamImpact(onchain, '{not json', 'active', 'preprod')).toBeNull();
  });

  it('builds the island props for an active change', () => {
    const out = buildParamImpact(onchain, raw, 'active', 'preprod');
    expect(out?.network).toBe('preprod');
    expect(out?.keys).toEqual(['utxoCostPerByte']);
    expect(out?.current.utxoCostPerByte).toBeDefined();
    expect(out?.proposed.utxoCostPerByte).toBeDefined();
  });
});

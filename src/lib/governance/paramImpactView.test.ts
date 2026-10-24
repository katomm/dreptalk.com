import { describe, expect, it } from 'vitest';
import { basisEpoch } from './basisEpoch.js';
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

  it('is empty unless the action is active or decided', () => {
    for (const s of ['pending', 'closed']) {
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

describe('basisEpoch', () => {
  const base = { decidedEpoch: null, ratifiedEpoch: null, enactedEpoch: null, expiryEpoch: null };
  it('follows the status', () => {
    expect(basisEpoch({ ...base, status: 'enacted', enactedEpoch: 614 })).toBe(613);
    expect(basisEpoch({ ...base, status: 'enacted', decidedEpoch: 614 })).toBe(613);
    expect(basisEpoch({ ...base, status: 'expired', expiryEpoch: 661 })).toBe(660);
    expect(basisEpoch({ ...base, status: 'expired', decidedEpoch: 661 })).toBe(660);
    expect(basisEpoch({ ...base, status: 'dropped', decidedEpoch: 614 })).toBe(613);
    expect(basisEpoch({ ...base, status: 'ratified', ratifiedEpoch: 613 })).toBe(613);
    expect(basisEpoch({ ...base, status: 'active' })).toBeNull();
    expect(basisEpoch({ ...base, status: 'expired' })).toBeNull();
  });
});

describe('buildParamImpact', () => {
  const network = 'preprod' as const;
  const row = { optimal_pool_count: 500, influence: 0.3, monetary_expand_rate: 0.003, treasury_growth_rate: 0.2 };
  const build = (o: Partial<Parameters<typeof buildParamImpact>[0]>) =>
    buildParamImpact({ payloadJson: payload({ stakePoolTargetNum: 600 }), status: 'enacted', currentRow: row, basisEpoch: 613, poolDataStored: true, network, ...o });

  it('builds an enacted section from the basis row', () => {
    const out = build({});
    expect(out?.keys).toEqual(['k']);
    expect(out?.outcome).toBe('enacted');
    expect(out?.basisEpoch).toBe(613);
    expect(Object.keys(out?.current ?? {}).sort()).toEqual(['a0', 'k', 'rho', 'tau']);
  });

  it('drops pool-data keys without stored pool data', () => {
    expect(build({ poolDataStored: false })).toBeNull();
    const out = build({
      poolDataStored: false,
      payloadJson: payload({ utxoCostPerByte: 3000, stakePoolTargetNum: 600 }),
      currentRow: { ...row, coins_per_utxo_size: 4310 },
    });
    expect(out?.keys).toEqual(['utxoCostPerByte']);
  });

  it('drops equal values once decided but not while active', () => {
    expect(build({ payloadJson: payload({ stakePoolTargetNum: 600 }), currentRow: { ...row, optimal_pool_count: 600 } })).toBeNull();
    expect(build({ status: 'active', basisEpoch: null, currentRow: { ...row, optimal_pool_count: 600 } })?.keys).toEqual(['k']);
  });

  it('leaves out a key the basis row cannot supply', () => {
    const out = build({ status: 'expired', payloadJson: payload({ stakePoolTargetNum: 600, minPoolCost: 100000000 }) });
    expect(out?.keys).toEqual(['k']);
    expect(out?.outcome).toBe('ended');
  });

  it('maps ratified and active to open', () => {
    expect(build({ status: 'ratified' })?.outcome).toBe('open');
    expect(build({ status: 'active', basisEpoch: null })?.basisEpoch).toBeNull();
  });

  it('is null for other statuses and a missing row', () => {
    expect(build({ status: 'closed' })).toBeNull();
    expect(build({ currentRow: null })).toBeNull();
  });
});

// Where the rewards chart goes: on the k or a0 card, in the combined section, or nowhere.
import { describe, it, expect } from 'vitest';
import { impactPlacement } from './impactPlan.js';
import { valuesFromJson, type ParamKey, type ParamValues } from '@/lib/governance/paramDefs.js';
import { REWARD_KEYS } from '@/lib/governance/paramImpact.js';
import { validParamValues, type ParamChangePanelState } from '@/lib/governance/govActionFormState.js';

const one = { n: 1n, d: 1n };

const current = valuesFromJson({
  k: { n: '500', d: '1' },
  a0: { n: '3', d: '10' },
  minPoolCost: { n: '170000000', d: '1' },
  rho: { n: '3', d: '1000' },
  tau: { n: '1', d: '5' },
  utxoCostPerByte: { n: '4310', d: '1' },
});

/** The rule the panel used before it moved here, written out against the picked keys. */
function oldRule(picked: readonly ParamKey[], next: ParamValues) {
  const rewardKeys = picked.filter((key) => (REWARD_KEYS as readonly ParamKey[]).includes(key) && next[key]);
  const combined = rewardKeys.length >= 2;
  const rewardsHost = rewardKeys.length === 1 && (rewardKeys[0] === 'k' || rewardKeys[0] === 'a0') ? rewardKeys[0] : null;
  return { combined, rewardsHost };
}

describe('impactPlacement', () => {
  it('keeps the rewards chart on the k card for k alone', () => {
    expect(impactPlacement({ k: one })).toEqual({ combined: false, rewardsHost: 'k' });
  });

  it('keeps the rewards chart on the a0 card for a0 alone', () => {
    expect(impactPlacement({ a0: one })).toEqual({ combined: false, rewardsHost: 'a0' });
  });

  it('gives rho alone no rewards chart', () => {
    expect(impactPlacement({ rho: one })).toEqual({ combined: false, rewardsHost: null });
  });

  it('combines two reward parameters', () => {
    expect(impactPlacement({ k: one, tau: one })).toEqual({ combined: true, rewardsHost: null });
  });

  it('matches the builder rule for picked valid values', () => {
    const panels: ParamChangePanelState[] = [
      { prev: null, picked: ['k'], inputs: { k: '600' } },
      { prev: null, picked: ['a0', 'minPoolCost'], inputs: { a0: '0.35', minPoolCost: '200' } },
      { prev: null, picked: ['k', 'a0'], inputs: { k: '600', a0: '0.35' } },
      // A second reward chip without a value yet does not count.
      { prev: null, picked: ['k', 'a0'], inputs: { k: '600' } },
      // A reward value with a field error does not count either.
      { prev: null, picked: ['k', 'rho', 'tau'], inputs: { k: '600', rho: '0.35', tau: '35' } },
      { prev: null, picked: ['minPoolCost', 'rho'], inputs: { minPoolCost: '200', rho: '0.25' } },
      { prev: null, picked: ['utxoCostPerByte'], inputs: { utxoCostPerByte: '3500' } },
      { prev: null, picked: ['rho', 'tau'], inputs: { rho: '0.25', tau: '25' } },
      { prev: null, picked: [], inputs: {} },
    ];
    for (const panel of panels) {
      const next = validParamValues(panel, current);
      expect(impactPlacement(next)).toEqual(oldRule(panel.picked, next));
    }
  });
});

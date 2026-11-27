// Where the rewards chart goes: on the k or a0 card, in the combined section, or nowhere.
import { describe, it, expect } from 'vitest';
import { impactPlacement } from './impactPlan.js';
import { valuesFromJson } from '@/lib/governance/paramDefs.js';
import { validParamValues } from '@/lib/governance/govActionFormState.js';

const one = { n: 1n, d: 1n };

const current = valuesFromJson({
  k: { n: '500', d: '1' },
  a0: { n: '3', d: '10' },
  minPoolCost: { n: '170000000', d: '1' },
  rho: { n: '3', d: '1000' },
  tau: { n: '1', d: '5' },
  utxoCostPerByte: { n: '4310', d: '1' },
});

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

  it('counts only reward values that are filled in and valid', () => {
    // A second reward chip without a value yet does not count.
    const empty = validParamValues({ prev: null, picked: ['k', 'a0'], inputs: { k: '600' } }, current);
    expect(impactPlacement(empty)).toEqual({ combined: false, rewardsHost: 'k' });
    // A reward value with a field error (tau above its guardrail) does not count either.
    const invalid = validParamValues({ prev: null, picked: ['k', 'tau'], inputs: { k: '600', tau: '35' } }, current);
    expect(impactPlacement(invalid)).toEqual({ combined: false, rewardsHost: 'k' });
  });
});

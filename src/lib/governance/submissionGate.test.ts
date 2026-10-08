// Unit tests for the single availability switch that gates governance action
// submission. See submissionGate.ts for why this is the one place that flips.

import { describe, it, expect } from 'vitest';
import { govActionSubmissionAvailable, govActionTypeAvailable } from './submissionGate.js';
import { GOV_ACTION_FORM_TYPES } from './prevAction.js';

describe('govActionSubmissionAvailable', () => {
  it('is available on preprod', () => {
    expect(govActionSubmissionAvailable('preprod')).toBe(true);
  });

  it('is not available on mainnet', () => {
    expect(govActionSubmissionAvailable('mainnet')).toBe(false);
  });
});

describe('govActionTypeAvailable', () => {
  it('offers every type on preprod, treasury withdrawals included', () => {
    for (const type of GOV_ACTION_FORM_TYPES) {
      expect(govActionTypeAvailable(type, { submissionAvailable: true, network: 'preprod' })).toBe(true);
    }
  });

  it('offers nothing where submission is off', () => {
    for (const network of ['preprod', 'mainnet'] as const) {
      for (const type of GOV_ACTION_FORM_TYPES) {
        expect(govActionTypeAvailable(type, { submissionAvailable: false, network })).toBe(false);
      }
    }
  });

  // The switch is ON here, so only the guardrail rule can refuse: emptying
  // GUARDRAIL_FORM_TYPES makes this test fail.
  it('refuses only the guardrail types on mainnet with submission switched on', () => {
    const on = { submissionAvailable: true, network: 'mainnet' } as const;
    expect(GOV_ACTION_FORM_TYPES.filter((type) => !govActionTypeAvailable(type, on))).toEqual([
      'TreasuryWithdrawals',
      'ParameterChange',
    ]);
  });
});

describe('ParameterChange availability', () => {
  it('offers parameter changes on preprod only, whatever the switch says', () => {
    expect(govActionTypeAvailable('ParameterChange', { submissionAvailable: true, network: 'preprod' })).toBe(true);
    expect(govActionTypeAvailable('ParameterChange', { submissionAvailable: true, network: 'mainnet' })).toBe(false);
    expect(govActionTypeAvailable('ParameterChange', { submissionAvailable: false, network: 'preprod' })).toBe(false);
    // Control: a type without a guardrail follows the switch on mainnet.
    expect(govActionTypeAvailable('InfoAction', { submissionAvailable: true, network: 'mainnet' })).toBe(true);
  });
});

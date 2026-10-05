import { describe, expect, it } from 'vitest';
import { latestRefundEpoch } from './depositRefund.js';

describe('latestRefundEpoch', () => {
  it('is the submit epoch plus the lifetime plus one, as on preprod', () => {
    expect(latestRefundEpoch({ epoch_no: 310, gov_action_lifetime: 6 })).toBe(317);
  });

  it('is null while either figure is missing', () => {
    expect(latestRefundEpoch(null)).toBeNull();
    expect(latestRefundEpoch({ epoch_no: 310 })).toBeNull();
    expect(latestRefundEpoch({ epoch_no: null, gov_action_lifetime: 6 })).toBeNull();
    expect(latestRefundEpoch({ epoch_no: 310, gov_action_lifetime: '6' })).toBeNull();
  });
});

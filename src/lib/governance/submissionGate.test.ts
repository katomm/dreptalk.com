// Unit tests for the single availability switch that gates governance action
// submission. See submissionGate.ts for why this is the one place that flips.

import { describe, it, expect } from 'vitest';
import { govActionSubmissionAvailable } from './submissionGate.js';

describe('govActionSubmissionAvailable', () => {
  it('is available on preprod', () => {
    expect(govActionSubmissionAvailable('preprod')).toBe(true);
  });

  it('is not available on mainnet', () => {
    expect(govActionSubmissionAvailable('mainnet')).toBe(false);
  });
});

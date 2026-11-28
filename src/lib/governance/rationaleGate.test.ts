import { describe, expect, it } from 'vitest';
import { belowRationaleGate } from './rationaleGate.js';

describe('belowRationaleGate', () => {
  it('gates DReps under 10,000 ada and those with unknown power', () => {
    expect(belowRationaleGate('9999999999')).toBe(true);
    expect(belowRationaleGate('0')).toBe(true);
    expect(belowRationaleGate(null)).toBe(true);
  });

  it('lets DReps at or above 10,000 ada through', () => {
    expect(belowRationaleGate('10000000000')).toBe(false);
    expect(belowRationaleGate(52_000_000_000_000)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { committeeEpochForAction } from './committee.js';

describe('committeeEpochForAction', () => {
  it('uses the decided epoch when the action is decided', () => {
    expect(committeeEpochForAction(638, 700)).toBe(638);
  });

  it('falls back to the current epoch while still open', () => {
    expect(committeeEpochForAction(null, 700)).toBe(700);
  });

  it('is null when neither epoch is known', () => {
    expect(committeeEpochForAction(null, null)).toBeNull();
  });
});

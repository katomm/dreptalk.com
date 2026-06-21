import { describe, it, expect } from 'vitest';
import { EDIT_GRACE_MS, isWithinGrace } from './editPolicy.js';

describe('editPolicy', () => {
  it('grace window is 15 minutes', () => {
    expect(EDIT_GRACE_MS).toBe(15 * 60 * 1000);
  });

  it('is within grace at the moment of posting', () => {
    expect(isWithinGrace(1000, 1000)).toBe(true);
  });

  it('is within grace just before the window closes', () => {
    expect(isWithinGrace(0, EDIT_GRACE_MS - 1)).toBe(true);
  });

  it('is within grace exactly at the boundary', () => {
    // now - createdAt == EDIT_GRACE_MS counts as still inside (<=).
    expect(isWithinGrace(0, EDIT_GRACE_MS)).toBe(true);
  });

  it('is past grace once the window has elapsed', () => {
    expect(isWithinGrace(0, EDIT_GRACE_MS + 1)).toBe(false);
  });
});

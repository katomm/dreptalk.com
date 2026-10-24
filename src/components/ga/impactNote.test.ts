import { describe, it, expect } from 'vitest';
import { impactNote } from './impactNote.js';

describe('impactNote', () => {
  it('says what the proposed values would do while the action is open', () => {
    expect(impactNote('open', true, null)).toBe(
      'What the proposed values would do, computed from the current pool distribution and parameters, so read them as an estimate.',
    );
    expect(impactNote('open', false, null)).toBe(
      'What the proposed values would do, computed from the current parameters, so read them as an estimate.',
    );
    expect(impactNote('open', true, 613)).toBe(impactNote('open', true, null));
  });

  it('names the epoch for an enacted change', () => {
    expect(impactNote('enacted', true, 613)).toBe(
      'What this change did, computed from the pool distribution and parameters of epoch 613 before it took effect, so read it as an estimate.',
    );
    expect(impactNote('enacted', false, 613)).toBe(
      'What this change did, computed from the parameters of epoch 613 before it took effect, so read it as an estimate.',
    );
  });

  it('names the epoch for an ended proposal', () => {
    expect(impactNote('ended', true, 612)).toBe(
      'What it would have done, computed from the pool distribution and parameters of epoch 612, so read it as an estimate.',
    );
    expect(impactNote('ended', false, 612)).toBe(
      'What it would have done, computed from the parameters of epoch 612, so read it as an estimate.',
    );
  });

  it('falls back to the open sentences without an epoch', () => {
    expect(impactNote('enacted', true, null)).toBe(impactNote('open', true, null));
    expect(impactNote('ended', false, null)).toBe(impactNote('open', false, null));
  });
});

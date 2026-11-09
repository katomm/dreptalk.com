import { describe, expect, it } from 'vitest';
import { drepGroupsAvailable } from './gate.js';
import { credentialForDrepId, drepIdForCredential, groupIdParam, groupIdString } from './ids.js';

describe('drepGroupsAvailable', () => {
  it('is true on preprod and mainnet', () => {
    expect(drepGroupsAvailable('preprod')).toBe(true);
    expect(drepGroupsAvailable('mainnet')).toBe(true);
    expect(drepGroupsAvailable('mainnet', ['preprod'])).toBe(false);
    expect(drepGroupsAvailable(undefined)).toBe(false);
  });
});

describe('drep ids', () => {
  it('round trips key and script credentials with a drep1 prefix', () => {
    for (const c of [
      { kind: 'key', hash: '11'.repeat(28) },
      { kind: 'script', hash: '22'.repeat(28) },
    ] as const) {
      const id = drepIdForCredential(c);
      expect(id.startsWith('drep1')).toBe(true);
      expect(credentialForDrepId(id)).toEqual(c);
    }
  });
  it('returns null for garbage', () => {
    expect(credentialForDrepId('nope')).toBeNull();
  });
});

describe('group ids', () => {
  const ref = { txHash: 'ab'.repeat(32), index: 3 };
  it('round trips and accepts uppercase input', () => {
    const s = groupIdString(ref);
    expect(groupIdParam(s)).toEqual(ref);
    expect(groupIdParam(s.toUpperCase())).toEqual(ref);
  });
  it('returns null for garbage and undefined', () => {
    expect(groupIdParam('group1xyz')).toBeNull();
    expect(groupIdParam(undefined)).toBeNull();
  });
});

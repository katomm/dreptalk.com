// Unit test for the pure identity-match helper in DrepSettings. The wallet
// connect / tx flows mirror DRepService and are covered by the preprod e2e.
import { describe, it, expect } from 'vitest';
import { identityMatches } from './DrepSettings.js';

describe('identityMatches', () => {
  it('accepts the exact same drep id', () => {
    expect(identityMatches('drep1abc', 'drep1abc')).toBe(true);
  });

  it('rejects a different drep id', () => {
    expect(identityMatches('drep1abc', 'drep1xyz')).toBe(false);
  });

  it('is case-insensitive on the bech32 string', () => {
    expect(identityMatches('DRep1Abc', 'drep1abc')).toBe(true);
  });
});

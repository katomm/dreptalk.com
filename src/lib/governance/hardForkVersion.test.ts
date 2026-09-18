// Tests for hard fork protocol version rules mirroring the Conway ledger's
// GOV rule preceedingHardFork.
import { describe, expect, it } from 'vitest';
import { follows, type ProtocolVersion, versionsThatFollow } from './hardForkVersion.js';

describe('follows', () => {
  it('is true for a major bump to minor 0', () => {
    expect(follows({ major: 10, minor: 2 }, { major: 11, minor: 0 })).toBe(true);
  });

  it('is true for a minor bump within the same major', () => {
    expect(follows({ major: 10, minor: 2 }, { major: 10, minor: 3 })).toBe(true);
  });

  it('is false for a major bump to a non-zero minor', () => {
    expect(follows({ major: 10, minor: 2 }, { major: 11, minor: 1 })).toBe(false);
  });

  it('is false for a minor bump that skips a value', () => {
    expect(follows({ major: 10, minor: 2 }, { major: 10, minor: 4 })).toBe(false);
  });

  it('is false for a major jump of more than one', () => {
    expect(follows({ major: 10, minor: 2 }, { major: 12, minor: 0 })).toBe(false);
  });

  it('is false for the same version', () => {
    expect(follows({ major: 10, minor: 2 }, { major: 10, minor: 2 })).toBe(false);
  });
});

describe('versionsThatFollow', () => {
  it('returns both candidates, major-bump first, when base equals active', () => {
    const base: ProtocolVersion = { major: 10, minor: 2 };
    const active: ProtocolVersion = { major: 10, minor: 2 };
    expect(versionsThatFollow(base, active)).toEqual([
      { major: 11, minor: 0 },
      { major: 10, minor: 3 },
    ]);
  });

  it('drops the major-bump candidate when its major exceeds active.major + 1', () => {
    const active: ProtocolVersion = { major: 10, minor: 0 };
    const base: ProtocolVersion = { major: 11, minor: 0 };
    expect(versionsThatFollow(base, active)).toEqual([{ major: 11, minor: 1 }]);
  });

  it('returns both candidates for an open prev one minor ahead of active', () => {
    const active: ProtocolVersion = { major: 10, minor: 0 };
    const base: ProtocolVersion = { major: 10, minor: 1 };
    expect(versionsThatFollow(base, active)).toEqual([
      { major: 11, minor: 0 },
      { major: 10, minor: 2 },
    ]);
  });
});

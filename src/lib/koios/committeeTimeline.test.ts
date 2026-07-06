import { describe, expect, it } from 'vitest';
import {
  activeCommitteeMembersAt,
  activeCommitteeSizeAt,
  type CommitteeMemberTerm,
} from './committeeTimeline.js';

// Mirrors committee v2 (active epochs 581 to 601, 7 members) with the real
// resignation: cold-key 349e55f8 de-registered its hot key at epoch 597.
const v2: CommitteeMemberTerm[] = [
  { coldKeyHex: 'resigner', versionFrom: 581, versionTo: 601, termExpiration: 653, authorizedFrom: 507, resignedAt: 597 },
  ...Array.from({ length: 6 }, (_, i) => ({
    coldKeyHex: `m${i}`,
    versionFrom: 581,
    versionTo: 601 as number | null,
    termExpiration: 653,
    authorizedFrom: 507,
    resignedAt: null as number | null,
  })),
];

describe('activeCommitteeSizeAt', () => {
  it('counts all 7 members before the resignation', () => {
    expect(activeCommitteeSizeAt(v2, 596)).toBe(7);
  });

  it('drops the resigned member from the epoch of resignation onward', () => {
    expect(activeCommitteeSizeAt(v2, 597)).toBe(6);
    expect(activeCommitteeSizeAt(v2, 601)).toBe(6);
  });

  it('excludes term-expired members (still active during the expiration epoch)', () => {
    const bootstrap: CommitteeMemberTerm[] = [
      { coldKeyHex: 'x', versionFrom: 500, versionTo: null, termExpiration: 580, authorizedFrom: 507, resignedAt: null },
    ];
    expect(activeCommitteeSizeAt(bootstrap, 580)).toBe(1);
    expect(activeCommitteeSizeAt(bootstrap, 581)).toBe(0);
  });

  it('excludes members whose version has not started or has already ended', () => {
    expect(activeCommitteeSizeAt(v2, 580)).toBe(0); // v2 starts 581
    expect(activeCommitteeSizeAt(v2, 602)).toBe(0); // v2 ends 601
  });

  it('excludes members whose hot key was not yet registered', () => {
    const late: CommitteeMemberTerm[] = [
      { coldKeyHex: 'y', versionFrom: 581, versionTo: null, termExpiration: 653, authorizedFrom: 586, resignedAt: null },
    ];
    expect(activeCommitteeSizeAt(late, 585)).toBe(0);
    expect(activeCommitteeSizeAt(late, 586)).toBe(1);
  });
});

describe('activeCommitteeMembersAt', () => {
  it('returns the active cold keys, excluding the resigned one from its epoch', () => {
    expect(activeCommitteeMembersAt(v2, 596).has('resigner')).toBe(true);
    expect(activeCommitteeMembersAt(v2, 597).has('resigner')).toBe(false);
    expect(activeCommitteeMembersAt(v2, 597).size).toBe(6);
  });
});

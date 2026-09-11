import { describe, expect, it } from 'vitest';
import {
  activeCommitteeMembersAt,
  activeCommitteeMembersAtBoundary,
  activeCommitteeMembersFor,
  activeCommitteeSizeAt,
  activeCommitteeSizeFor,
  boundaryOf,
  observedAt,
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

// The seeded mainnet committee (migration 0048): the interim version 507 to 580,
// the elected version 581 to 601 with three members authorizing their hot keys
// only in 582, 582 and 586, and the Atlantic Council resignation in epoch 597.
const seed: CommitteeMemberTerm[] = [
  { coldKeyHex: 'atlantic', versionFrom: 507, versionTo: 580, termExpiration: 580, authorizedFrom: 507, resignedAt: 597 },
  { coldKeyHex: 'eastern', versionFrom: 507, versionTo: 580, termExpiration: 580, authorizedFrom: 508, resignedAt: null },
  { coldKeyHex: 'cf', versionFrom: 507, versionTo: 580, termExpiration: 580, authorizedFrom: 507, resignedAt: null },
  { coldKeyHex: 'japan-icc', versionFrom: 507, versionTo: 580, termExpiration: 580, authorizedFrom: 511, resignedAt: null },
  { coldKeyHex: 'io', versionFrom: 507, versionTo: 580, termExpiration: 580, authorizedFrom: 507, resignedAt: null },
  { coldKeyHex: 'intersect', versionFrom: 507, versionTo: 580, termExpiration: 580, authorizedFrom: 508, resignedAt: null },
  { coldKeyHex: 'emurgo', versionFrom: 507, versionTo: 580, termExpiration: 580, authorizedFrom: 507, resignedAt: null },
  { coldKeyHex: 'phil', versionFrom: 581, versionTo: 601, termExpiration: 653, authorizedFrom: 586, resignedAt: null },
  { coldKeyHex: 'tingvard', versionFrom: 581, versionTo: 601, termExpiration: 726, authorizedFrom: 581, resignedAt: null },
  { coldKeyHex: 'atlantic', versionFrom: 581, versionTo: 601, termExpiration: 653, authorizedFrom: 507, resignedAt: 597 },
  { coldKeyHex: 'eastern', versionFrom: 581, versionTo: 601, termExpiration: 726, authorizedFrom: 508, resignedAt: null },
  { coldKeyHex: 'ace', versionFrom: 581, versionTo: 601, termExpiration: 726, authorizedFrom: 582, resignedAt: null },
  { coldKeyHex: 'japan', versionFrom: 581, versionTo: 601, termExpiration: 653, authorizedFrom: 582, resignedAt: null },
  { coldKeyHex: 'ktorz', versionFrom: 581, versionTo: 601, termExpiration: 653, authorizedFrom: 578, resignedAt: null },
];

describe('activeCommitteeMembersAtBoundary', () => {
  it('keeps a member who resigned inside the epoch a ratification opened (the loan at 597)', () => {
    const at597 = activeCommitteeMembersAtBoundary(seed, 597);
    expect(at597.has('atlantic')).toBe(true);
    expect(at597.size).toBe(7);
    // The epoch-end reading of the same epoch has already lost the member.
    expect(activeCommitteeMembersAt(seed, 597).size).toBe(6);
    // One boundary later the resignation has happened.
    expect(activeCommitteeMembersAtBoundary(seed, 598).has('atlantic')).toBe(false);
  });

  it('counts the whole interim committee at the constitution ratification (541)', () => {
    expect(activeCommitteeMembersAtBoundary(seed, 541).size).toBe(7);
  });

  it('applies the committee version enacted at the same boundary and drops the outgoing terms (581)', () => {
    const at581 = activeCommitteeMembersAtBoundary(seed, 581);
    // Interim terms expired with 580, the new version counts, but only the seats
    // whose hot key was authorized before epoch 581.
    expect([...at581].sort()).toEqual(['atlantic', 'eastern', 'ktorz']);
    expect(at581.has('tingvard')).toBe(false); // authorized inside 581
    expect(at581.has('cf')).toBe(false); // term ended with 580
  });

  it('does not count a hot key authorized inside the boundary epoch, but does one boundary later', () => {
    expect(activeCommitteeMembersAtBoundary(seed, 582).has('tingvard')).toBe(true);
    expect(activeCommitteeMembersAtBoundary(seed, 582).has('ace')).toBe(false);
    expect(activeCommitteeMembersAtBoundary(seed, 583).has('ace')).toBe(true);
    expect(activeCommitteeMembersAtBoundary(seed, 601).size).toBe(6); // seven seats, Atlantic resigned
  });

  it('excludes a term that expired in the epoch before the boundary', () => {
    const one: CommitteeMemberTerm[] = [
      { coldKeyHex: 'x', versionFrom: 500, versionTo: null, termExpiration: 580, authorizedFrom: 500, resignedAt: null },
    ];
    expect(activeCommitteeMembersAtBoundary(one, 580).size).toBe(1);
    expect(activeCommitteeMembersAtBoundary(one, 581).size).toBe(0);
  });
});

describe('activeCommitteeMembersFor', () => {
  it('dispatches a boundary and an observed reference, and reads a bare number as observed', () => {
    expect(activeCommitteeMembersFor(seed, boundaryOf(597)).size).toBe(7);
    expect(activeCommitteeMembersFor(seed, observedAt(597)).size).toBe(6);
    expect(activeCommitteeMembersFor(seed, 597).size).toBe(6);
    expect(activeCommitteeSizeFor(seed, boundaryOf(581))).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';
import {
  activeCommitteeMembersAtBoundary,
  activeCommitteeSizeAtBoundary,
  committeeBoundaryForAction,
  committeeStanding,
  decisionBoundaryEpoch,
  versionCovers,
  type CommitteeMemberTerm,
} from './committeeTimeline.js';

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
    // One boundary later the resignation has happened.
    expect(activeCommitteeMembersAtBoundary(seed, 598).has('atlantic')).toBe(false);
    expect(activeCommitteeSizeAtBoundary(seed, 598)).toBe(6);
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

describe('committeeStanding', () => {
  const m: CommitteeMemberTerm = { coldKeyHex: 'x', versionFrom: 581, versionTo: null, termExpiration: 653, authorizedFrom: 586, resignedAt: 640 };

  it('names why a seat does not count, in the order the ledger would notice', () => {
    expect(committeeStanding(m, 585)).toBe('not-authorized');
    expect(committeeStanding(m, 586)).toBe('not-authorized');
    expect(committeeStanding(m, 587)).toBeNull();
    expect(committeeStanding(m, 640)).toBeNull();
    expect(committeeStanding(m, 641)).toBe('resigned');
    expect(committeeStanding(m, 654)).toBe('expired');
  });

  it('is the rule the boundary set is built from', () => {
    expect([...activeCommitteeMembersAtBoundary(seed, 597)].every((c) => seed.some((s) => s.coldKeyHex === c && versionCovers(s, 597) && committeeStanding(s, 597) == null))).toBe(true);
  });
});

describe('decisionBoundaryEpoch and committeeBoundaryForAction', () => {
  it('reads the ratified epoch, or derives it for a pre-0093 enacted row', () => {
    expect(decisionBoundaryEpoch({ status: 'enacted', decidedEpoch: 598, ratifiedEpoch: 597 })).toBe(597);
    expect(decisionBoundaryEpoch({ status: 'ratified', decidedEpoch: 597, ratifiedEpoch: 597 })).toBe(597);
    expect(decisionBoundaryEpoch({ status: 'enacted', decidedEpoch: 638 })).toBe(637);
  });

  it('places an expired action at its expiry epoch, a closed or dropped one at its decided epoch', () => {
    expect(decisionBoundaryEpoch({ status: 'expired', decidedEpoch: 581, expiryEpoch: 581 })).toBe(581);
    expect(decisionBoundaryEpoch({ status: 'expired', decidedEpoch: 546 })).toBe(546);
    expect(decisionBoundaryEpoch({ status: 'closed', decidedEpoch: 529 })).toBe(529);
    expect(decisionBoundaryEpoch({ status: 'dropped', decidedEpoch: 614 })).toBe(614);
  });

  it('has no boundary for an open action, or without a lifecycle epoch', () => {
    expect(decisionBoundaryEpoch({ status: 'active', decidedEpoch: null })).toBeNull();
    expect(decisionBoundaryEpoch({ status: 'enacted', decidedEpoch: null })).toBeNull();
  });

  it('judges an open action at the next transition and a decided one at its boundary', () => {
    expect(committeeBoundaryForAction({ status: 'active', decidedEpoch: null }, 700)).toBe(701);
    expect(committeeBoundaryForAction({ status: 'enacted', decidedEpoch: 598, ratifiedEpoch: 597 }, 700)).toBe(597);
    expect(committeeBoundaryForAction({ status: 'active', decidedEpoch: null }, null)).toBeNull();
  });
});

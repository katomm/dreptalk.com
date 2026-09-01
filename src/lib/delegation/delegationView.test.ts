import { describe, it, expect } from 'vitest';
import { resolveDelegationView, drepStatusHint, isRetiredStatus } from './delegationView.js';
import type { DelegatorFollowRow } from '@/lib/db/delegatorFollows.js';

function makeFollow(over: Partial<DelegatorFollowRow>): DelegatorFollowRow {
  return {
    user_id: 'u', stake_addr: 'stake1x',
    resolution_status: 'resolved', delegation_type: 'drep', drep_id: 'drep1abc',
    checked_at: 100, delegation_set_at: 100, refresh_attempted_at: 100, refresh_error_at: null,
    delegated_since_epoch: null, since_checked_at: null, since_attempts: 0,
    ...over,
  };
}

describe('resolveDelegationView', () => {
  it('null follow -> no-follow', () => {
    expect(resolveDelegationView(null)).toEqual({ kind: 'no-follow' });
  });
  it('pending row -> pending', () => {
    expect(resolveDelegationView(makeFollow({ resolution_status: 'pending', delegation_type: null, drep_id: null, checked_at: null, delegation_set_at: null }))).toEqual({ kind: 'pending' });
  });
  it('resolved drep -> drep with drepId', () => {
    expect(resolveDelegationView(makeFollow({ delegation_type: 'drep', drep_id: 'drep1abc' }))).toEqual({ kind: 'drep', drepId: 'drep1abc', staleError: false });
  });
  it('resolved drep with refresh_error_at -> staleError true', () => {
    expect(resolveDelegationView(makeFollow({ delegation_type: 'drep', drep_id: 'drep1abc', refresh_error_at: 200 }))).toEqual({ kind: 'drep', drepId: 'drep1abc', staleError: true });
  });
  it('resolved abstain -> abstain', () => {
    expect(resolveDelegationView(makeFollow({ delegation_type: 'abstain', drep_id: null }))).toEqual({ kind: 'abstain', staleError: false });
  });
  it('resolved no_confidence -> no_confidence', () => {
    expect(resolveDelegationView(makeFollow({ delegation_type: 'no_confidence', drep_id: null }))).toEqual({ kind: 'no_confidence', staleError: false });
  });
  it('resolved none -> none', () => {
    expect(resolveDelegationView(makeFollow({ delegation_type: 'none', drep_id: null }))).toEqual({ kind: 'none', staleError: false });
  });
});

describe('drepStatusHint', () => {
  it('active -> null', () => { expect(drepStatusHint(true, 'registered')).toBeNull(); });
  it('inactive non-retired -> inactive text', () => { expect(drepStatusHint(false, 'expired')).toContain('currently inactive'); });
  it('deregistered -> retired text', () => { expect(drepStatusHint(false, 'deregistered')).toContain('ended its registration'); });
});

describe('isRetiredStatus', () => {
  it('is true only for the statuses that mean the registration ended', () => {
    expect(isRetiredStatus('deregistered')).toBe(true);
    expect(isRetiredStatus('RETIRED')).toBe(true);
    // An inactive DRep is still allowed to vote, so it is not retired.
    expect(isRetiredStatus('expired')).toBe(false);
    expect(isRetiredStatus('registered')).toBe(false);
    expect(isRetiredStatus('')).toBe(false);
  });
});

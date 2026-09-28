import { describe, it, expect } from 'vitest';
import { resolveDelegationView, isRetiredStatus, resolveAwaiting } from './delegationView.js';
import { EXPECTED_TTL_SEC } from './expectation.js';
import type { DelegatorFollowRow } from '@/lib/db/delegatorFollows.js';

function makeFollow(over: Partial<DelegatorFollowRow>): DelegatorFollowRow {
  return {
    user_id: 'u', stake_addr: 'stake1x',
    resolution_status: 'resolved', delegation_type: 'drep', drep_id: 'drep1abc',
    checked_at: 100, delegation_set_at: 100, refresh_attempted_at: 100, refresh_error_at: null,
    delegated_since_epoch: null, since_checked_at: null, since_attempts: 0,
    expected_drep_id: null, expected_at: null, expected_tx: null,
    ...over,
  };
}

describe('resolveDelegationView', () => {
  it('pending row -> pending', () => {
    expect(resolveDelegationView(makeFollow({ resolution_status: 'pending', delegation_type: null, drep_id: null, checked_at: null, delegation_set_at: null }))).toEqual({ kind: 'pending' });
  });
  it('resolved drep with refresh_error_at -> staleError true', () => {
    expect(resolveDelegationView(makeFollow({ delegation_type: 'drep', drep_id: 'drep1abc', refresh_error_at: 200 }))).toEqual({ kind: 'drep', drepId: 'drep1abc', staleError: true });
  });
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

describe('resolveAwaiting', () => {
  it('reports the expectation over an old drep follow', () => {
    const follow = makeFollow({ drep_id: 'OLD', expected_drep_id: 'NEW', expected_at: 1000, expected_tx: 'tx' });
    expect(resolveAwaiting(follow, resolveDelegationView(follow), 1100)).toEqual({ drepId: 'NEW', txHash: 'tx' });
  });

  it('reports the expectation over a pending row', () => {
    const follow = makeFollow({
      resolution_status: 'pending', delegation_type: null, drep_id: null,
      checked_at: null, delegation_set_at: null,
      expected_drep_id: 'NEW', expected_at: 1000,
    });
    expect(resolveAwaiting(follow, resolveDelegationView(follow), 1100)).toEqual({ drepId: 'NEW', txHash: null });
  });

  it('reports the expectation over a row with no delegation on record', () => {
    const follow = makeFollow({ delegation_type: 'none', drep_id: null, expected_drep_id: 'NEW', expected_at: 1000 });
    expect(resolveAwaiting(follow, resolveDelegationView(follow), 1100)).toEqual({ drepId: 'NEW', txHash: null });
  });

  it('reports nothing once the chain agrees', () => {
    const follow = makeFollow({ drep_id: 'NEW', expected_drep_id: 'NEW', expected_at: 1000 });
    expect(resolveAwaiting(follow, resolveDelegationView(follow), 1100)).toBeNull();
  });

  it('reports nothing after the window', () => {
    const follow = makeFollow({ drep_id: 'OLD', expected_drep_id: 'NEW', expected_at: 1000 });
    expect(resolveAwaiting(follow, resolveDelegationView(follow), 1000 + EXPECTED_TTL_SEC + 1)).toBeNull();
  });

  it('reports nothing without a follow row', () => {
    expect(resolveAwaiting(null, { kind: 'no-follow' }, 1000)).toBeNull();
  });
});

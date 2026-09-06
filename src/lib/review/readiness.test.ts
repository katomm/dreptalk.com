import { describe, it, expect } from 'vitest';
import { classifyEpoch } from './readiness.js';

const base = { seriesFloor: 508, staleOpenActions: 0, unfetchedVoteActions: 0 };

describe('classifyEpoch', () => {
  it('is ready with a complete stats row and no stale open action', () => {
    expect(classifyEpoch({ ...base, epoch: 650, statsRow: { voteDataComplete: true } }).ready).toBe(true);
  });
  it('is pending with an incomplete stats row', () => {
    const r = classifyEpoch({ ...base, epoch: 652, statsRow: { voteDataComplete: false } });
    expect(r.stats).toBe('pending');
    expect(r.ready).toBe(false);
  });
  it('treats a missing row before the series floor as unavailable, not pending', () => {
    const r = classifyEpoch({ ...base, epoch: 507, statsRow: null });
    expect(r.stats).toBe('not_available_before_start');
    expect(r.ready).toBe(true);
  });
  it('is pending while an action open during the epoch has not been synced past the boundary', () => {
    const r = classifyEpoch({ ...base, epoch: 650, statsRow: { voteDataComplete: true }, staleOpenActions: 1 });
    expect(r.actions).toBe('pending');
    expect(r.ready).toBe(false);
  });
  it('is pending while a frozen action still awaits its final vote fetch', () => {
    const r = classifyEpoch({ ...base, epoch: 652, statsRow: { voteDataComplete: true }, unfetchedVoteActions: 1 });
    expect(r.votes).toBe('pending');
    expect(r.ready).toBe(false);
  });
});

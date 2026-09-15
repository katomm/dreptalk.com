import { describe, it, expect } from 'vitest';
import { classifySnapshot } from './votingTimingSnapshotHealth.js';
import { SNAPSHOT_OVERDUE_MS, type VotingTimingSnapshotPayload } from '../db/votingTimingSnapshot.js';

const now = 1_000_000_000_000;

const payload: VotingTimingSnapshotPayload = {
  drepByType: [], spoByType: [], drepOverall: null, spoOverall: null,
  half: { medianDay: null, basis: 0 },
  thirds: { early: 0, middle: 0, late: 0, afterClose: 0, basis: 0 },
};

describe('classifySnapshot', () => {
  it('allows four missed six-hourly runs before counting as overdue', () => {
    expect(SNAPSHOT_OVERDUE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('reports absent when there is no row', () => {
    expect(classifySnapshot(null, now).state).toBe('absent');
  });

  it('reports fresh just inside the threshold', () => {
    const h = classifySnapshot({ computedAt: now - SNAPSHOT_OVERDUE_MS + 1000, epoch: 9, payload }, now);
    expect(h.state).toBe('fresh');
    expect(h.ageMs).toBe(SNAPSHOT_OVERDUE_MS - 1000);
  });

  it('reports overdue exactly one millisecond past the threshold', () => {
    expect(classifySnapshot({ computedAt: now - SNAPSHOT_OVERDUE_MS - 1, epoch: 9, payload }, now).state).toBe('overdue');
  });

  it('reports invalid for a fresh row whose payload did not validate', () => {
    expect(classifySnapshot({ computedAt: now - 1000, epoch: 9, payload: null }, now).state).toBe('invalid');
  });

  it('prefers invalid over overdue, since an unusable row is the worse problem', () => {
    expect(classifySnapshot({ computedAt: now - SNAPSHOT_OVERDUE_MS - 1, epoch: 9, payload: null }, now).state).toBe('invalid');
  });
});

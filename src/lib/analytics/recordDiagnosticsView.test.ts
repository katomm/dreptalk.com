import { describe, expect, it } from 'vitest';
import { buildHistogram, buildTimingDetail } from './recordDiagnosticsView.js';
import type { NetworkConfig } from '../config/network.js';
import type { NetworkTypeTiming, OwnVoteTiming } from '../db/recordDiagnostics.js';

// Small fake cfg anchored at epoch 0 = unix 0, so epochStartMs(epoch, cfg) is
// exactly epoch * 432_000_000 (5-day epochs in ms) and every expectation
// below is hand-computable without touching the real mainnet/preprod anchors.
const cfg: NetworkConfig = {
  network: 'mainnet',
  koiosBaseUrl: '',
  addrPrefix: 'addr',
  stakePrefix: 'stake',
  networkId: 1,
  epochAnchor: { epoch: 0, unixSeconds: 0 },
  siteOrigin: '',
};

const ownVote = (over: Partial<OwnVoteTiming>): OwnVoteTiming => ({
  type: 'InfoAction',
  blockTime: 0,
  submittedAt: 0,
  decidedEpoch: 1,
  expiryEpoch: null,
  ...over,
});

const netTiming = (over: Partial<NetworkTypeTiming>): NetworkTypeTiming => ({
  type: 'ParameterChange',
  medianDay: 2.5,
  timedVotes: 50,
  ...over,
});

describe('buildHistogram', () => {
  it('buckets values including the exact bucket boundaries', () => {
    const buckets = buildHistogram([20, 100], null);
    const b20 = buckets.find((b) => b.fromPct === 20)!;
    const b90 = buckets.find((b) => b.fromPct === 90)!;
    expect(b20).toMatchObject({ toPct: 30, count: 1 });
    expect(b90).toMatchObject({ toPct: 100, count: 1 });
    // every other bucket stayed empty
    expect(buckets.filter((b) => b.count > 0)).toHaveLength(2);
  });

  it('marks the bucket containing the own value', () => {
    const buckets = buildHistogram([5, 25, 45], 45);
    const marked = buckets.filter((b) => b.isOwn);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ fromPct: 40, toPct: 50, count: 1 });
  });

  it('clamps an own value outside 0..100 into the nearest real bucket', () => {
    const high = buildHistogram([5], 150);
    expect(high.find((b) => b.isOwn)).toMatchObject({ fromPct: 90, toPct: 100 });
    const low = buildHistogram([5], -5);
    expect(low.find((b) => b.isOwn)).toMatchObject({ fromPct: 0, toPct: 10 });
  });

  it('returns 10 zero buckets for empty input', () => {
    const buckets = buildHistogram([], null);
    expect(buckets).toHaveLength(10);
    expect(buckets.every((b) => b.count === 0 && !b.isOwn)).toBe(true);
    expect(buckets.map((b) => b.fromPct)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('marks nothing when own value is null', () => {
    const buckets = buildHistogram([10, 20, 95], null);
    expect(buckets.every((b) => !b.isOwn)).toBe(true);
  });
});

describe('buildTimingDetail: per-type medians', () => {
  it('computes own vs network medians with the 3-vote floor and a mixed-unit day formula', () => {
    // submittedAt is milliseconds, blockTime is seconds: blockTime = (submittedAt + day * 86_400_000) / 1000.
    const submittedAt = 1_000_000_000_000;
    const atDay = (day: number) => (submittedAt + day * 86_400_000) / 1000;

    const own: OwnVoteTiming[] = [
      // ParameterChange: 3 votes, days 1/2/3, median 2. Network has this type.
      ownVote({ type: 'ParameterChange', submittedAt, blockTime: atDay(1) }),
      ownVote({ type: 'ParameterChange', submittedAt, blockTime: atDay(2) }),
      ownVote({ type: 'ParameterChange', submittedAt, blockTime: atDay(3) }),
      // TreasuryWithdrawals: 4 votes, days 1/2/4/5, median 3. Network lacks this type.
      ownVote({ type: 'TreasuryWithdrawals', submittedAt, blockTime: atDay(1) }),
      ownVote({ type: 'TreasuryWithdrawals', submittedAt, blockTime: atDay(2) }),
      ownVote({ type: 'TreasuryWithdrawals', submittedAt, blockTime: atDay(4) }),
      ownVote({ type: 'TreasuryWithdrawals', submittedAt, blockTime: atDay(5) }),
      // InfoAction: only 2 votes, below the 3-vote floor, must not appear.
      ownVote({ type: 'InfoAction', submittedAt, blockTime: atDay(1) }),
      ownVote({ type: 'InfoAction', submittedAt, blockTime: atDay(5) }),
    ];
    const network: NetworkTypeTiming[] = [netTiming({ type: 'ParameterChange', medianDay: 2.5 })];

    const detail = buildTimingDetail(own, network, cfg);

    expect(detail.types).toEqual([
      // ownVotes descending first: TreasuryWithdrawals (4) before ParameterChange (3).
      { type: 'TreasuryWithdrawals', ownMedianDay: 3, networkMedianDay: null, ownVotes: 4 },
      { type: 'ParameterChange', ownMedianDay: 2, networkMedianDay: 2.5, ownVotes: 3 },
    ]);
  });

  it('sorts ties by ownVotes descending then type ascending', () => {
    const submittedAt = 0;
    const votes = (type: string) => [1, 2, 3].map((day) =>
      ownVote({ type, submittedAt, blockTime: (day * 86_400_000) / 1000 }),
    );
    const own = [...votes('TreasuryWithdrawals'), ...votes('InfoAction'), ...votes('ParameterChange')];

    const detail = buildTimingDetail(own, [], cfg);

    expect(detail.types.map((t) => t.type)).toEqual(['InfoAction', 'ParameterChange', 'TreasuryWithdrawals']);
  });
});

describe('buildTimingDetail: early/middle/late window classification', () => {
  it('classifies votes placed in each third of a hand-built window', () => {
    // decidedEpoch 1 -> window end = epochStartMs(1, cfg) = 432_000_000 ms.
    // Submitted at epoch start (0), so the window is exactly 432_000_000 ms wide.
    const submittedAt = 0;
    const early = ownVote({ submittedAt, blockTime: 86_400_000 / 1000, decidedEpoch: 1 }); // day 1, position 0.2
    const middle = ownVote({ submittedAt, blockTime: 216_000_000 / 1000, decidedEpoch: 1 }); // day 2.5, position 0.5
    const late = ownVote({ submittedAt, blockTime: 400_000_000 / 1000, decidedEpoch: 1 }); // day ~4.63, position ~0.926

    const detail = buildTimingDetail([early, middle, late], [], cfg);

    expect(detail.early).toBe(1);
    expect(detail.middle).toBe(1);
    expect(detail.late).toBe(1);
    expect(detail.windowBasis).toBe(3);
    expect(detail.skippedWindows).toBe(0);
  });

  it('treats the exact 1/3 and 2/3 boundaries as middle, not early or late', () => {
    const submittedAt = 0;
    // position exactly 1/3: dayMs = 144_000_000.
    const atThird = ownVote({ submittedAt, blockTime: 144_000_000 / 1000, decidedEpoch: 1 });
    // position exactly 2/3: dayMs = 288_000_000.
    const atTwoThirds = ownVote({ submittedAt, blockTime: 288_000_000 / 1000, decidedEpoch: 1 });

    const detail = buildTimingDetail([atThird, atTwoThirds], [], cfg);

    expect(detail.early).toBe(0);
    expect(detail.middle).toBe(2);
    expect(detail.late).toBe(0);
  });

  it('counts a vote with both decidedEpoch and expiryEpoch null as a skipped window', () => {
    const vote = ownVote({ submittedAt: 0, blockTime: 1000, decidedEpoch: null, expiryEpoch: null });

    const detail = buildTimingDetail([vote], [], cfg);

    expect(detail.skippedWindows).toBe(1);
    expect(detail.windowBasis).toBe(0);
  });

  it('counts a vote with a non-positive window (submitted at or past the window end) as skipped', () => {
    // decidedEpoch 0 -> window end = epochStartMs(0, cfg) = 0, submittedAt = 1000 -> windowMs = -1000.
    const vote = ownVote({ submittedAt: 1000, blockTime: 1, decidedEpoch: 0, expiryEpoch: null });

    const detail = buildTimingDetail([vote], [], cfg);

    expect(detail.skippedWindows).toBe(1);
    expect(detail.windowBasis).toBe(0);
  });

  it('counts a vote cast after the window closed as skipped, not late', () => {
    // decidedEpoch 1 -> window end = epochStartMs(1, cfg) = 432_000_000 ms.
    // blockTime lands the vote at day 6 (518_400_000 ms), past the window end.
    const vote = ownVote({ submittedAt: 0, blockTime: 518_400_000 / 1000, decidedEpoch: 1 });

    const detail = buildTimingDetail([vote], [], cfg);

    expect(detail.skippedWindows).toBe(1);
    expect(detail.early).toBe(0);
    expect(detail.middle).toBe(0);
    expect(detail.late).toBe(0);
    expect(detail.windowBasis).toBe(0);
  });

  it('drops a negative-day vote entirely, before it can reach type stats or window classification', () => {
    // blockTime * 1000 < submittedAt -> day < 0. decidedEpoch/expiryEpoch both
    // null so, if this vote were not dropped first, it would otherwise count
    // as a skipped window: skippedWindows staying 0 proves the drop happens
    // before the window pass, not as a form of "skipped".
    const vote = ownVote({
      type: 'InfoAction',
      submittedAt: 1_000_000,
      blockTime: 1,
      decidedEpoch: null,
      expiryEpoch: null,
    });

    const detail = buildTimingDetail([vote], [], cfg);

    expect(detail.types).toEqual([]);
    expect(detail.early + detail.middle + detail.late).toBe(0);
    expect(detail.windowBasis).toBe(0);
    expect(detail.skippedWindows).toBe(0);
  });

  it('returns all zeros and an empty types list for no input', () => {
    const detail = buildTimingDetail([], [], cfg);
    expect(detail).toEqual({ types: [], early: 0, middle: 0, late: 0, windowBasis: 0, skippedWindows: 0 });
  });
});

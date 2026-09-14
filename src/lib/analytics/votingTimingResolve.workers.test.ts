import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveVotingTimingView, resolveNetworkTypeTiming } from './votingTimingResolve.js';
import { buildVotingTiming } from './votingTimingView.js';
import { buildTimingDetail } from './recordDiagnosticsView.js';
import { median } from './median.js';
import { writeVotingTimingSnapshot } from '../db/votingTimingSnapshot.js';
import { loadVotingTimingSnapshot } from './votingTimingSnapshot.js';
import * as recordDiagnostics from '../db/recordDiagnostics.js';
import { resolveNetwork } from '../config/network.js';
import { seedVotingTimingFixture, FOCUS_DREP } from '../db/votingTimingFixture.workers.js';

const cfg = resolveNetwork('preprod');

/** The finished analytics view, computed the way the page computed it before. */
async function liveAnalyticsView() {
  const [drepByType, spoByType, drepOverall, spoOverall, halfDays, thirds] = await Promise.all([
    recordDiagnostics.getNetworkTimingByType(env.DB, 'DRep'),
    recordDiagnostics.getNetworkTimingByType(env.DB, 'SPO'),
    recordDiagnostics.getNetworkTimingOverall(env.DB, 'DRep'),
    recordDiagnostics.getNetworkTimingOverall(env.DB, 'SPO'),
    recordDiagnostics.getHalfTurnoutDays(env.DB),
    recordDiagnostics.getWindowThirds(env.DB, cfg.epochAnchor),
  ]);
  return buildVotingTiming({
    drepByType, spoByType, drepOverall, spoOverall, thirds,
    half: { medianDay: median(halfDays), basis: halfDays.length },
  });
}

function spies() {
  return {
    byType: vi.spyOn(recordDiagnostics, 'getNetworkTimingByType'),
    overall: vi.spyOn(recordDiagnostics, 'getNetworkTimingOverall'),
    half: vi.spyOn(recordDiagnostics, 'getHalfTurnoutDays'),
    thirds: vi.spyOn(recordDiagnostics, 'getWindowThirds'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('analytics path equality', () => {
  it('produces the same view from the snapshot as from the live computation', async () => {
    await seedVotingTimingFixture(cfg);
    const expected = await liveAnalyticsView();
    expect(expected.byType.length).toBeGreaterThan(0);
    expect(expected.byType[0].spoMedianDay).not.toBeNull();
    expect(expected.halfBasis % 2).toBe(0);

    expect(await resolveVotingTimingView(env.DB, cfg)).toEqual(expected);

    await writeVotingTimingSnapshot(env.DB, await loadVotingTimingSnapshot(env.DB, cfg), 1, 1);
    expect(await resolveVotingTimingView(env.DB, cfg)).toEqual(expected);
  });

  it('runs zero live aggregates on a snapshot hit, and all six on a miss', async () => {
    await seedVotingTimingFixture(cfg);
    const payload = await loadVotingTimingSnapshot(env.DB, cfg);

    // Positive control: with no row the spies must record six calls. If they
    // record zero here the interception is broken and the hit assertions below
    // would be meaningless.
    const miss = spies();
    await resolveVotingTimingView(env.DB, cfg);
    expect(miss.byType).toHaveBeenCalledTimes(2);
    expect(miss.overall).toHaveBeenCalledTimes(2);
    expect(miss.half).toHaveBeenCalledTimes(1);
    expect(miss.thirds).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();

    await writeVotingTimingSnapshot(env.DB, payload, 1, 1);
    const hit = spies();
    await resolveVotingTimingView(env.DB, cfg);
    expect(hit.byType).not.toHaveBeenCalled();
    expect(hit.overall).not.toHaveBeenCalled();
    expect(hit.half).not.toHaveBeenCalled();
    expect(hit.thirds).not.toHaveBeenCalled();
  });
});

describe('record path equality', () => {
  it('produces the same timing detail from the snapshot as from the live call', async () => {
    await seedVotingTimingFixture(cfg);
    const liveNetwork = await recordDiagnostics.getNetworkTimingByType(env.DB, 'DRep');
    const ownTimings = await recordDiagnostics.listOwnVoteTimings(env.DB, FOCUS_DREP);
    const expected = buildTimingDetail(ownTimings, liveNetwork, cfg);

    // Without these guards the comparison can pass on two empty lists:
    // buildTimingDetail emits no type row until a DRep has three own timed
    // votes of that type.
    expect(expected.types.length).toBeGreaterThan(0);
    expect(expected.types[0].networkMedianDay).not.toBeNull();

    expect(await resolveNetworkTypeTiming(env.DB)).toEqual(liveNetwork);

    await writeVotingTimingSnapshot(env.DB, await loadVotingTimingSnapshot(env.DB, cfg), 1, 1);
    const fromSnapshot = await resolveNetworkTypeTiming(env.DB);
    expect(buildTimingDetail(ownTimings, fromSnapshot, cfg)).toEqual(expected);

    // Counter-check: a wrong network median must change the finished view,
    // otherwise the assertion above proves nothing about it being used.
    const tampered = fromSnapshot.map((t) => ({ ...t, medianDay: t.medianDay + 1 }));
    expect(buildTimingDetail(ownTimings, tampered, cfg)).not.toEqual(expected);
  });

  it('falls back to exactly one DRep aggregate call, never the full six', async () => {
    const miss = spies();
    await resolveNetworkTypeTiming(env.DB);
    expect(miss.byType).toHaveBeenCalledTimes(1);
    // Assert on the role argument only. Passing env.DB into the matcher makes
    // chai try to serialize a D1Database for its diff output, which throws.
    expect(miss.byType.mock.calls[0][1]).toBe('DRep');
    expect(miss.overall).not.toHaveBeenCalled();
    expect(miss.half).not.toHaveBeenCalled();
    expect(miss.thirds).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    await writeVotingTimingSnapshot(env.DB, await loadVotingTimingSnapshot(env.DB, cfg), 1, 1);
    const hit = spies();
    await resolveNetworkTypeTiming(env.DB);
    expect(hit.byType).not.toHaveBeenCalled();
    expect(hit.overall).not.toHaveBeenCalled();
    expect(hit.half).not.toHaveBeenCalled();
    expect(hit.thirds).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { loadVotingTimingSnapshot } from '../analytics/votingTimingSnapshot.js';
import { readVotingTimingSnapshot, writeVotingTimingSnapshot } from './votingTimingSnapshot.js';
import {
  getNetworkTimingByType,
  getNetworkTimingOverall,
  getHalfTurnoutDays,
  getWindowThirds,
} from './recordDiagnostics.js';
import { median } from '../analytics/median.js';
import { resolveNetwork } from '../config/network.js';
import { seedVotingTimingFixture } from './votingTimingFixture.workers.js';

const cfg = resolveNetwork('preprod');

describe('loadVotingTimingSnapshot', () => {
  it('matches the six live aggregate results for the same DB state', async () => {
    await seedVotingTimingFixture(cfg);
    const [drepByType, spoByType, drepOverall, spoOverall, halfDays, thirds] = await Promise.all([
      getNetworkTimingByType(env.DB, 'DRep'),
      getNetworkTimingByType(env.DB, 'SPO'),
      getNetworkTimingOverall(env.DB, 'DRep'),
      getNetworkTimingOverall(env.DB, 'SPO'),
      getHalfTurnoutDays(env.DB),
      getWindowThirds(env.DB, cfg.epochAnchor),
    ]);

    // Guard the fixture itself: a degenerate seed would make the equality
    // assertions below pass vacuously.
    const info = drepByType.find((t) => t.type === 'InfoAction');
    const thin = drepByType.find((t) => t.type === 'TreasuryWithdrawals');
    expect(info!.timedVotes).toBeGreaterThanOrEqual(20);
    expect(thin!.timedVotes).toBeLessThan(20);
    expect(spoByType.find((t) => t.type === 'InfoAction')!.timedVotes).toBeGreaterThanOrEqual(20);
    expect(halfDays.length % 2).toBe(0);
    expect(halfDays.length).toBeGreaterThan(0);
    // All four window buckets populated, so the thirds are not a first-third blob.
    expect(thirds.early).toBeGreaterThan(0);
    expect(thirds.middle).toBeGreaterThan(0);
    expect(thirds.late).toBeGreaterThan(0);
    expect(thirds.afterClose).toBeGreaterThan(0);

    const payload = await loadVotingTimingSnapshot(env.DB, cfg);

    expect(payload.drepByType).toEqual(drepByType);
    expect(payload.spoByType).toEqual(spoByType);
    expect(payload.drepOverall).toEqual(drepOverall);
    expect(payload.spoOverall).toEqual(spoOverall);
    expect(payload.thirds).toEqual(thirds);
    // Computed independently, so a broken reduction cannot agree with itself.
    expect(payload.half).toEqual({ medianDay: median(halfDays), basis: halfDays.length });
  });

  it('produces a payload the reader accepts back, even on an empty database', async () => {
    const payload = await loadVotingTimingSnapshot(env.DB, cfg);
    await writeVotingTimingSnapshot(env.DB, payload, 1, 1);
    expect((await readVotingTimingSnapshot(env.DB))?.payload).toEqual(payload);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drepPhases } from './dreps.js';
import { readVotingTimingSnapshot, writeVotingTimingSnapshot } from '../../db/votingTimingSnapshot.js';
import * as snapshotModule from '../../db/votingTimingSnapshot.js';
import * as loaderModule from '../../analytics/votingTimingSnapshot.js';
import { resolveNetwork, epochFromUnix } from '../../config/network.js';
import { seedVotingTimingFixture } from '../../db/votingTimingFixture.workers.js';
import type { DrepSyncContext } from './dreps.js';

const cfg = resolveNetwork('preprod');

/**
 * Partial context for the phase, which reads only db and cfg. This is still a
 * cast, so it does NOT turn a future dependency on another context field into a
 * compile error. It is narrower and more readable than `as never`, nothing more.
 */
function ctx(): DrepSyncContext {
  return { db: env.DB, cfg } as unknown as DrepSyncContext;
}

function phase() {
  const def = drepPhases.find((d) => d.name === 'voting-timing-snapshot');
  if (!def) throw new Error('voting-timing-snapshot phase is not registered');
  return def;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('voting-timing-snapshot phase', () => {
  it('writes a readable snapshot whose epoch is the compute epoch', async () => {
    await seedVotingTimingFixture(cfg);
    const before = Date.now();

    expect((await phase().run(ctx())).items).toBe(1);

    const meta = await readVotingTimingSnapshot(env.DB);
    expect(meta!.payload).not.toBeNull();
    expect(meta!.computedAt).toBeGreaterThanOrEqual(before);
    expect(meta!.epoch).toBe(epochFromUnix(meta!.computedAt / 1000, cfg));
    // The anchor epoch is a per network constant (preprod 4), so a stored epoch
    // equal to it would mean the compute epoch was never derived.
    expect(meta!.epoch).not.toBe(cfg.epochAnchor.epoch);
  });

  it('does not touch the stored row when the compute fails', async () => {
    await phase().run(ctx());
    const good = await readVotingTimingSnapshot(env.DB);

    const write = vi.spyOn(snapshotModule, 'writeVotingTimingSnapshot');
    vi.spyOn(loaderModule, 'loadVotingTimingSnapshot').mockRejectedValue(new Error('compute failed'));

    await expect(phase().run(ctx())).rejects.toThrow('compute failed');
    expect(write).not.toHaveBeenCalled();
    expect(await readVotingTimingSnapshot(env.DB)).toEqual(good);
  });

  it('leaves the previous row intact when the real writer fails', async () => {
    await phase().run(ctx());
    const good = await readVotingTimingSnapshot(env.DB);

    // Deliberately contract-violating input: computed_at is NOT NULL, so this
    // drives the real writer down its real SQL path and makes that statement
    // fail. Calling the writer itself is the point: a hand rolled INSERT with a
    // different id would test the table constraint and not this function, and
    // would still pass if the writer later grew a destructive DELETE first.
    await expect(
      writeVotingTimingSnapshot(env.DB, good!.payload!, null as unknown as number, 7),
    ).rejects.toThrow();

    expect(await readVotingTimingSnapshot(env.DB)).toEqual(good);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drepPhases } from './dreps.js';
import { runPhases } from './registry.js';
import { recordSyncRun } from '../runRecorder.js';
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
  it('is registered and is not the primary phase', () => {
    expect(phase().primary).toBeFalsy();
  });

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

  it('records its failure in sync_runs and lets later phases keep running', async () => {
    vi.spyOn(loaderModule, 'loadVotingTimingSnapshot').mockRejectedValue(new Error('boom'));
    const ran: string[] = [];

    // The real recorder, not a stand-in: the assertion is that runRecorder
    // persists the failure and continues, which a test-owned catch callback
    // would only simulate.
    await recordSyncRun(env.DB, 'dreps', async (phaseFn) => {
      await runPhases(
        [phase(), { name: 'after', run: async () => { ran.push('after'); return { items: 0 }; } }],
        ctx(),
        phaseFn,
      );
    });

    expect(ran).toEqual(['after']);
    const run = await env.DB
      .prepare('SELECT status, phases FROM sync_runs ORDER BY id DESC LIMIT 1')
      .first<{ status: string; phases: string }>();
    expect(run?.status).toBe('partial');
    const phases = JSON.parse(run!.phases) as { phase: string; ok: boolean; error?: string }[];
    const mine = phases.find((x) => x.phase === 'voting-timing-snapshot');
    expect(mine?.ok).toBe(false);
    expect(mine?.error).toContain('boom');
    expect(phases.find((x) => x.phase === 'after')?.ok).toBe(true);
  });
});

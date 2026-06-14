import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { startSyncRun, finishSyncRun, listSyncRuns, pruneSyncRuns, reapStaleSyncRuns, STALE_RUN_MS } from './syncRuns.js';

const NOW = 1_748_000_000_000;

describe('sync_runs', () => {
  it('starts a run as running and finalizes it with phases', async () => {
    const id = await startSyncRun(env.DB, 'dreps', NOW);

    let runs = await listSyncRuns(env.DB, 10);
    const running = runs.find((r) => r.id === id);
    expect(running).toMatchObject({ kind: 'dreps', status: 'running', startedAt: NOW, finishedAt: null });

    await finishSyncRun(env.DB, id, {
      status: 'partial',
      items: 120,
      failed: 3,
      error: 'koios request failed: 503',
      phases: [
        { phase: 'dreps', ok: true, ms: 1500, items: 120, failed: 3 },
        { phase: 'avatars', ok: false, ms: 200, items: 0, failed: 0, error: 'koios request failed: 503' },
      ],
      finishedAt: NOW + 2000,
    });

    runs = await listSyncRuns(env.DB, 10);
    const done = runs.find((r) => r.id === id);
    expect(done).toMatchObject({ status: 'partial', items: 120, failed: 3, finishedAt: NOW + 2000 });
    expect(done!.phases).toHaveLength(2);
    expect(done!.phases[1]).toMatchObject({ phase: 'avatars', ok: false });
  });

  it('lists most recent runs first and prunes old ones', async () => {
    const oldId = await startSyncRun(env.DB, 'governance', NOW - 100_000);
    const newId = await startSyncRun(env.DB, 'governance', NOW + 100_000);

    const runs = await listSyncRuns(env.DB, 50);
    const oldIdx = runs.findIndex((r) => r.id === oldId);
    const newIdx = runs.findIndex((r) => r.id === newId);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(oldIdx);

    const pruned = await pruneSyncRuns(env.DB, NOW);
    expect(pruned).toBeGreaterThanOrEqual(1);
    const after = await listSyncRuns(env.DB, 50);
    expect(after.find((r) => r.id === oldId)).toBeUndefined();
    expect(after.find((r) => r.id === newId)).toBeDefined();
  });

  it('reaps a stale running row as killed but leaves a fresh one running', async () => {
    const stale = await startSyncRun(env.DB, 'votes', NOW - STALE_RUN_MS - 1_000);
    const fresh = await startSyncRun(env.DB, 'votes', NOW - 1_000);

    const reaped = await reapStaleSyncRuns(env.DB, NOW);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const runs = await listSyncRuns(env.DB, 200);
    const s = runs.find((r) => r.id === stale);
    const f = runs.find((r) => r.id === fresh);
    expect(s).toMatchObject({ status: 'killed' });
    expect(s!.finishedAt).not.toBeNull();
    expect(f).toMatchObject({ status: 'running', finishedAt: null });
  });
});

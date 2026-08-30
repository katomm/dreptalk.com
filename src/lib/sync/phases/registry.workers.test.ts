// Acceptance pin for the registry refactor: a throwing phase must have exactly
// the same effect through runPhases as it had with hand-wired phase calls. The
// later phases still run, and sync_runs records the failed phase plus 'partial'.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { recordSyncRun } from '../runRecorder.js';
import { listSyncRuns } from '../../db/syncRuns.js';
import { runPhases, type SyncPhaseDef } from './registry.js';

describe('runPhases through recordSyncRun', () => {
  it('isolates a throwing phase, keeps later phases running, and records partial', async () => {
    let tailRan = false;
    const defs: SyncPhaseDef<{ label: string }>[] = [
      { name: 'head', primary: true, run: async () => ({ items: 5 }) },
      { name: 'broken', run: async () => { throw new Error('koios 503'); } },
      { name: 'tail', run: async () => { tailRan = true; return { items: 2 }; } },
    ];

    const summary = await recordSyncRun(env.DB, 'votes', (phase) =>
      runPhases(defs, { label: 'ctx' }, phase),
    );

    expect(tailRan).toBe(true);
    expect(summary.status).toBe('partial');
    expect(summary.items).toBe(7);
    expect(summary.error).toBe('koios 503');

    const run = (await listSyncRuns(env.DB, 1))[0];
    expect(run.status).toBe('partial');
    expect(run.phases.map((p) => ({ phase: p.phase, ok: p.ok }))).toEqual([
      { phase: 'head', ok: true },
      { phase: 'broken', ok: false },
      { phase: 'tail', ok: true },
    ]);
  });

  it('marks the run error when the primary phase throws, still running the rest', async () => {
    let tailRan = false;
    const defs: SyncPhaseDef<Record<string, never>>[] = [
      { name: 'head', primary: true, run: async () => { throw new Error('down'); } },
      { name: 'tail', run: async () => { tailRan = true; return {}; } },
    ];

    const summary = await recordSyncRun(env.DB, 'governance', (phase) => runPhases(defs, {}, phase));

    expect(tailRan).toBe(true);
    expect(summary.status).toBe('error');
  });
});

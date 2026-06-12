import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { recordSyncRun } from './runRecorder.js';
import { listSyncRuns } from '../db/syncRuns.js';

describe('recordSyncRun', () => {
  it('records ok when every phase succeeds with no item failures', async () => {
    const summary = await recordSyncRun(env.DB, 'votes', async (phase) => {
      await phase('votes', async () => ({ items: 10, failed: 0 }), { primary: true });
      await phase('badges', async () => ({ items: 4 }));
    });

    expect(summary.status).toBe('ok');
    expect(summary.items).toBe(14);
    expect(summary.failed).toBe(0);

    const run = (await listSyncRuns(env.DB, 5))[0];
    expect(run).toMatchObject({ kind: 'votes', status: 'ok', items: 14 });
    expect(run.phases.map((p) => p.phase)).toEqual(['votes', 'badges']);
  });

  it('isolates a failing phase, keeps running, and reports partial', async () => {
    let laterPhaseRan = false;
    const summary = await recordSyncRun(env.DB, 'dreps', async (phase) => {
      await phase('dreps', async () => ({ items: 100, failed: 0 }), { primary: true });
      await phase('avatars', async () => {
        throw new Error('r2 unavailable');
      });
      await phase('slugs', async () => {
        laterPhaseRan = true;
        return { items: 2 };
      });
    });

    expect(laterPhaseRan).toBe(true);
    expect(summary.status).toBe('partial');
    expect(summary.error).toBe('r2 unavailable');
    expect(summary.phases.find((p) => p.phase === 'avatars')!.ok).toBe(false);
  });

  it('reports partial when items failed even though no phase threw', async () => {
    const summary = await recordSyncRun(env.DB, 'governance', async (phase) => {
      await phase('discovery', async () => ({ items: 50, failed: 2 }), { primary: true });
    });

    expect(summary.status).toBe('partial');
    expect(summary.failed).toBe(2);
  });

  it('reports error when the primary phase throws, still running later phases', async () => {
    let laterPhaseRan = false;
    const summary = await recordSyncRun(env.DB, 'dreps', async (phase) => {
      await phase('dreps', async () => {
        throw new Error('koios request failed: 503');
      }, { primary: true });
      await phase('slugs', async () => {
        laterPhaseRan = true;
        return {};
      });
    });

    expect(laterPhaseRan).toBe(true);
    expect(summary.status).toBe('error');
    expect(summary.error).toBe('koios request failed: 503');
  });

  it('still executes the run when bookkeeping is unavailable', async () => {
    const broken = {
      prepare() {
        throw new Error('no such table: sync_runs');
      },
    } as unknown as D1Database;

    let ran = false;
    const summary = await recordSyncRun(broken, 'votes', async (phase) => {
      await phase('votes', async () => {
        ran = true;
        return { items: 1 };
      }, { primary: true });
    });

    expect(ran).toBe(true);
    expect(summary.status).toBe('ok');
    expect(summary.items).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import type { PhaseFn, PhaseResult } from '../runRecorder.js';
import { activePhases, runPhases, type SyncPhaseDef } from './registry.js';

interface Ctx {
  heavy: boolean;
  tag: string;
}

/** PhaseFn stub that records the calls runPhases makes, mirroring runRecorder's contract. */
function recordingPhaseFn(calls: Array<{ name: string; primary: boolean; result: PhaseResult }>): PhaseFn {
  return async (name, fn, opts) => {
    const result = await fn();
    calls.push({ name, primary: opts?.primary === true, result });
  };
}

describe('activePhases', () => {
  it('keeps declaration order and drops phases whose when() rejects the context', () => {
    const defs: SyncPhaseDef<Ctx>[] = [
      { name: 'always', run: async () => ({}) },
      { name: 'heavy-only', when: (ctx) => ctx.heavy, run: async () => ({}) },
      { name: 'tail', run: async () => ({}) },
    ];

    expect(activePhases(defs, { heavy: false, tag: 'x' }).map((d) => d.name)).toEqual(['always', 'tail']);
    expect(activePhases(defs, { heavy: true, tag: 'x' }).map((d) => d.name)).toEqual(['always', 'heavy-only', 'tail']);
  });
});

describe('runPhases', () => {
  it('runs the active phases in order through the PhaseFn and forwards the primary flag', async () => {
    const defs: SyncPhaseDef<Ctx>[] = [
      { name: 'first', primary: true, run: async () => ({ items: 3 }) },
      { name: 'skipped', when: () => false, run: async () => ({ items: 99 }) },
      { name: 'second', run: async () => ({ items: 1, failed: 1 }) },
    ];
    const calls: Array<{ name: string; primary: boolean; result: PhaseResult }> = [];

    await runPhases(defs, { heavy: false, tag: 'x' }, recordingPhaseFn(calls));

    expect(calls).toEqual([
      { name: 'first', primary: true, result: { items: 3 } },
      { name: 'second', primary: false, result: { items: 1, failed: 1 } },
    ]);
  });

  it('hands each phase the shared run context', async () => {
    const seen: string[] = [];
    const defs: SyncPhaseDef<Ctx>[] = [
      { name: 'a', run: async (ctx) => { seen.push(ctx.tag); return {}; } },
      { name: 'b', run: async (ctx) => { seen.push(ctx.tag); return {}; } },
    ];

    await runPhases(defs, { heavy: true, tag: 'shared' }, recordingPhaseFn([]));

    expect(seen).toEqual(['shared', 'shared']);
  });
});

// Declarative phase registry for the gov-sync cron worker. Each cron kind owns
// an ordered list of SyncPhaseDef entries; runPhases feeds the active ones
// through runRecorder's PhaseFn, which provides the per-phase failure isolation
// and sync_runs bookkeeping. Gating (heavy/hourly ticks, optional bindings)
// lives in each entry's `when` predicate so it is inspectable as data.

import type { PhaseFn, PhaseResult } from '../runRecorder.js';

export interface SyncPhaseDef<Ctx> {
  name: string;
  /** A throwing primary phase marks the whole run 'error' instead of 'partial'. */
  primary?: boolean;
  /** Phase runs only when this predicate passes; omitted means every run. */
  when?: (ctx: Ctx) => boolean;
  run: (ctx: Ctx) => Promise<PhaseResult>;
}

/** The phases that would run for this context, in declaration order. */
export function activePhases<Ctx>(defs: readonly SyncPhaseDef<Ctx>[], ctx: Ctx): SyncPhaseDef<Ctx>[] {
  return defs.filter((d) => !d.when || d.when(ctx));
}

/** Name view of activePhases: the equivalence surface the registry tests pin. */
export function activePhaseNames<Ctx>(defs: readonly SyncPhaseDef<Ctx>[], ctx: Ctx): string[] {
  return activePhases(defs, ctx).map((d) => d.name);
}

export async function runPhases<Ctx>(
  defs: readonly SyncPhaseDef<Ctx>[],
  ctx: Ctx,
  phase: PhaseFn,
): Promise<void> {
  for (const d of activePhases(defs, ctx)) {
    await phase(d.name, () => d.run(ctx), d.primary ? { primary: true } : undefined);
  }
}

import type { NclPeriod } from '../../../config/ncl-periods.js';

export interface Withdrawal {
  enactedEpoch: number;
  lovelace: bigint;
}

export interface NclStatus {
  period: NclPeriod;
  consumedLovelace: bigint;
  remainingLovelace: bigint;
  /** Consumed as a percentage of the ceiling, one decimal place (can exceed 100). */
  consumedPct: number;
  /** Remaining as a percentage of the ceiling, one decimal place (0 when over budget). */
  remainingPct: number;
  withdrawalCount: number;
  overBudget: boolean;
}

/** ceiling>0 ? part/ceiling as a percentage rounded to one decimal, else 0. */
function pctOfCeiling(part: bigint, ceiling: bigint): number {
  return ceiling > 0n ? Number((part * 1000n) / ceiling) / 10 : 0;
}

export function nclStatusFor(period: NclPeriod, withdrawals: Withdrawal[]): NclStatus {
  let consumed = 0n;
  let count = 0;
  for (const w of withdrawals) {
    if (w.enactedEpoch >= period.startEpoch && w.enactedEpoch <= period.endEpoch) {
      consumed += w.lovelace;
      count++;
    }
  }
  const ceiling = period.ceilingLovelace;
  const remaining = consumed >= ceiling ? 0n : ceiling - consumed;
  return {
    period,
    consumedLovelace: consumed,
    remainingLovelace: remaining,
    consumedPct: pctOfCeiling(consumed, ceiling),
    remainingPct: pctOfCeiling(remaining, ceiling),
    withdrawalCount: count,
    overBudget: consumed > ceiling,
  };
}

export function currentNclPeriod(periods: NclPeriod[], epoch: number): NclPeriod | undefined {
  return periods.find((p) => epoch >= p.startEpoch && epoch <= p.endEpoch);
}

export type NclLifecycle = 'upcoming' | 'active' | 'completed';

/**
 * Where a period sits relative to the current epoch: not yet started, inside
 * its window, or over. Unknown current epoch (e.g. protocol params not synced
 * yet) defaults to 'active' so the UI doesn't guess a wrong lifecycle badge.
 */
export function nclLifecycle(period: NclPeriod, currentEpoch: number | null): NclLifecycle {
  if (currentEpoch == null) return 'active';
  if (currentEpoch < period.startEpoch) return 'upcoming';
  if (currentEpoch > period.endEpoch) return 'completed';
  return 'active';
}

/** Inline CSS for a lifecycle status badge (accent for active, positive for completed, muted otherwise). */
export function nclBadgeStyle(lifecycle: NclLifecycle): string {
  if (lifecycle === 'active') return 'background:var(--accent);color:var(--accent-fg);';
  if (lifecycle === 'completed') {
    return 'background:color-mix(in srgb, var(--c-pos) 18%, transparent);color:var(--c-pos);';
  }
  return 'background:var(--surface-2);color:var(--muted);';
}

/** Human label for a challenger/related action's on-chain status ('active' reads as 'currently voting'). */
export function nclActionStatusLabel(status: string): string {
  return status === 'active' ? 'currently voting' : status;
}

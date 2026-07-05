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
  withdrawalCount: number;
  overBudget: boolean;
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
  const consumedPct = ceiling > 0n ? Number((consumed * 1000n) / ceiling) / 10 : 0;
  return {
    period,
    consumedLovelace: consumed,
    remainingLovelace: remaining,
    consumedPct,
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

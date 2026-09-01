// Pure view model for the analytics hub's effective-representation panel.
// Honesty rule: an action without a voted-power reading or without a matching
// epoch-stats denominator is skipped, never rendered as a zero share. The
// denominator is the decision epoch's total, so every share is measured
// against the stake distribution that actually decided that action, not a
// live snapshot from a later epoch. Lovelace-to-Number conversion here is
// display-only, the shares are ratios and never need BigInt precision.
// Concentration data: when a powers map is provided, halfCount and voterCount
// are computed from buildVoteConcentration. The concentration honesty rule
// matches the vote-power rule: any missing per-voter power makes the whole
// concentration absent, never zero. Absent concentrations are excluded from
// the medianHalfCount. A second completeness condition also nulls the
// concentration when voterCount falls short of the action's own votesCast
// tally, since the per-vote rows sync separately and can lag behind it.
import type { DecidedActionRepresentation } from '../db/effectiveRepresentation.js';
import { buildVoteConcentration } from './voteConcentration.js';

export interface EffRepRow {
  id: string;
  title: string;
  href: string | null;
  type: string;
  decidedEpoch: number;
  powerSharePct: number;
  countSharePct: number | null;
  halfCount: number | null;
  voterCount: number | null;
}

export interface EffRepView {
  rows: EffRepRow[];
  medianPowerSharePct: number | null;
  medianHalfCount: number | null;
  skipped: number;
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function buildEffRep(
  actions: DecidedActionRepresentation[],
  powersByAction?: Map<string, (number | null)[]>,
): EffRepView {
  const rows: EffRepRow[] = [];
  let skipped = 0;
  for (const action of actions) {
    const totalDrepPower = action.totalDrepPower != null ? Number(action.totalDrepPower) : null;
    if (action.votedPower == null || totalDrepPower == null || totalDrepPower === 0) {
      skipped += 1;
      continue;
    }
    const powerSharePct = clampPct((action.votedPower / totalDrepPower) * 100);
    const countSharePct =
      action.poweredDrepCount != null && action.poweredDrepCount !== 0
        ? clampPct((action.votesCast / action.poweredDrepCount) * 100)
        : null;
    const rawConc = buildVoteConcentration(powersByAction?.get(action.id) ?? [], null);
    // Skew guard: the per-vote rows sync separately from the tally counts, so a
    // freshly decided action can hold fewer vote rows than the tally counted.
    // Late votes only ever push voterCount above votesCast, so this never fires falsely.
    const conc = rawConc && rawConc.voterCount < action.votesCast ? null : rawConc;
    rows.push({
      id: action.id,
      title: action.title ?? action.type,
      href: action.topicSlug != null ? `/t/${action.topicSlug}/` : null,
      type: action.type,
      decidedEpoch: action.decidedEpoch,
      powerSharePct,
      countSharePct,
      halfCount: conc?.halfCount ?? null,
      voterCount: conc?.voterCount ?? null,
    });
  }
  return {
    rows,
    medianPowerSharePct: median(rows.map((r) => r.powerSharePct)),
    medianHalfCount: median(rows.map((r) => r.halfCount).filter((n): n is number => n !== null)),
    skipped,
  };
}

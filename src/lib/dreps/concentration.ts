// Pure voting-power concentration math for the /dreps donut. No DB and no env
// access; the only dependency is the pure formatAda display helper. The input
// DReps are defensively sorted by power desc here, so callers need not pre-sort.
// Output is a small, JSON-serializable summary the donut island renders. Sums
// use BigInt because total DRep voting power in lovelace exceeds
// Number.MAX_SAFE_INTEGER.
import { formatAda } from '../forum/view.js';

export interface ConcentrationInput {
  drepId: string;
  name: string | null;
  power: bigint;
}

export interface ConcentrationTop {
  drepId: string;
  name: string | null;
  powerLabel: string;
  pct: number;
}

export interface ConcentrationPoint {
  count: number; // minimum DReps to reach this percent
  cumPct: number; // their actual cumulative share (>= the percent)
}

export interface Concentration {
  drepCount: number;
  totalLabel: string;
  topK: ConcentrationTop[];
  byPercent: ConcentrationPoint[]; // length 101, index = percent 0..100
}

const TOP_K = 12;

/** Clamps a (possibly negative) lovelace power to a non-negative BigInt. */
function clampPositive(power: bigint): bigint {
  return power > 0n ? power : 0n;
}

/** Two-decimal percent of `part` out of `total`, using BigInt to avoid overflow. */
function pctOf(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 10000n) / total) / 100;
}

function emptyByPercent(): ConcentrationPoint[] {
  return Array.from({ length: 101 }, () => ({ count: 0, cumPct: 0 }));
}

export function computeConcentration(dreps: ConcentrationInput[]): Concentration {
  const sorted = [...dreps].sort((a, b) => (a.power < b.power ? 1 : a.power > b.power ? -1 : 0));
  const total = sorted.reduce((acc, d) => acc + clampPositive(d.power), 0n);
  if (sorted.length === 0 || total <= 0n) {
    return { drepCount: sorted.length, totalLabel: formatAda('0'), topK: [], byPercent: emptyByPercent() };
  }

  const topK = sorted.slice(0, TOP_K).map((d) => {
    const power = clampPositive(d.power);
    return {
      drepId: d.drepId,
      name: d.name,
      powerLabel: formatAda(power.toString()),
      pct: pctOf(power, total),
    };
  });

  // Two-pointer over the sorted list: as the target percent rises, the minimum
  // coalition size is non-decreasing, so `idx` only ever advances.
  const byPercent: ConcentrationPoint[] = [{ count: 0, cumPct: 0 }];
  let idx = 0;
  let cum = 0n;
  for (let p = 1; p <= 100; p++) {
    while (idx < sorted.length && cum * 100n < total * BigInt(p)) {
      cum += clampPositive(sorted[idx].power);
      idx++;
    }
    byPercent[p] = { count: idx, cumPct: pctOf(cum, total) };
  }

  return { drepCount: sorted.length, totalLabel: formatAda(total.toString()), topK, byPercent };
}

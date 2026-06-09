// Pure rendering math for the DRep concentration donut. No React, no DOM, so it
// is unit-tested in the node pool; the .tsx island only wires state to these.
import type { ConcentrationPoint, ConcentrationTop } from './concentration.js';

export interface DonutSegment {
  pct: number;
  kind: 'top' | 'coalitionRest' | 'remainder';
}

/** Clamps a percent into 0..100 and returns the coalition point at that percent. */
export function coalitionAt(byPercent: ConcentrationPoint[], pct: number): ConcentrationPoint {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return byPercent[p] ?? { count: 0, cumPct: 0 };
}

/** Snaps a slider value to the nearest marker within `tolerance`, else returns it. */
export function snapThreshold(value: number, markers: number[], tolerance = 2): number {
  let best = value;
  let bestDist = tolerance + 1;
  for (const m of markers) {
    const d = Math.abs(m - value);
    if (d <= tolerance && d < bestDist) {
      best = m;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Builds the donut segments for a coalition: the top DReps inside it as
 * individual slices, any coalition members beyond the top-K as one slice, and
 * the rest of the ring as the muted remainder. Percentages are shares of total.
 */
export function buildSegments(topK: ConcentrationTop[], coalition: ConcentrationPoint): DonutSegment[] {
  const inCoalition = topK.slice(0, Math.min(coalition.count, topK.length));
  const segments: DonutSegment[] = inCoalition.map((t) => ({ pct: t.pct, kind: 'top' }));
  const topSum = inCoalition.reduce((acc, t) => acc + t.pct, 0);

  let highlighted = topSum;
  if (coalition.count > topK.length) {
    segments.push({ pct: Math.max(0, coalition.cumPct - topSum), kind: 'coalitionRest' });
    highlighted = coalition.cumPct;
  }

  segments.push({ pct: Math.max(0, 100 - highlighted), kind: 'remainder' });
  return segments;
}

/** Human summary, e.g. "Top 7 DReps hold 67% of active DRep voting power". */
export function summarySentence(count: number, pct: number): string {
  return `Top ${count.toLocaleString('en-US')} DReps hold ${Math.round(pct)}% of active DRep voting power`;
}

// Pure percentile computation for the DRep report card. Ranking definition:
// for a metric, a member's aheadPct is the percentage of the SAME cohort
// strictly below its own value, floored (Math.floor(100 * strictlyBelow /
// cohortSize)), computed by sorting once and walking with tie groups so
// every member sharing a value gets the same aheadPct. There are two
// independent layers. The outer cohort is every candidate whose eligible
// count (qualifying decided actions at or after registration) is at least
// minEligible (default 5), ranked by participation. The inner rationale
// cohort is the SUBSET of that outer cohort who cast at least one vote
// (rationaleCounts total > 0), ranked separately by rationale coverage. A
// candidate below minEligible gets no row at all, a cohort member with zero
// votes still gets a participation row but null rationale fields.
import type { ReportCardRow } from '../db/drepReportCard.js';

const DEFAULT_MIN_ELIGIBLE = 5;

interface ReportCardCandidate {
  drepId: string;
  registeredEpoch: number;
}

interface ReportCardInput {
  candidates: ReportCardCandidate[];
  qualifyingEpochs: number[];
  voteCounts: Map<string, number>;
  rationaleCounts: Map<string, { total: number; withRationale: number }>;
  now: number;
  minEligible?: number;
}

interface CohortMember {
  drepId: string;
  eligible: number;
  participationPct: number;
  rationale: { pct: number } | null;
}

// qualifyingEpochs is sorted ascending, so eligible (the count of entries at
// or after registeredEpoch) is a binary search for the first such entry.
function countEligible(qualifyingEpochs: number[], registeredEpoch: number): number {
  let lo = 0;
  let hi = qualifyingEpochs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (qualifyingEpochs[mid] < registeredEpoch) lo = mid + 1;
    else hi = mid;
  }
  return qualifyingEpochs.length - lo;
}

// Sorts once and walks with tie groups: every member sharing a value gets
// the same aheadPct, the count of strictly smaller values in the same pass.
function rankAheadPct<T>(items: T[], getValue: (item: T) => number): Map<T, number> {
  const sorted = [...items].sort((a, b) => getValue(a) - getValue(b));
  const cohortSize = sorted.length;
  const aheadPct = new Map<T, number>();
  let strictlyBelow = 0;
  let i = 0;
  while (i < sorted.length) {
    const value = getValue(sorted[i]);
    let j = i;
    while (j < sorted.length && getValue(sorted[j]) === value) j += 1;
    const pct = Math.floor((100 * strictlyBelow) / cohortSize);
    for (let k = i; k < j; k += 1) aheadPct.set(sorted[k], pct);
    strictlyBelow += j - i;
    i = j;
  }
  return aheadPct;
}

export function computeReportCards(input: ReportCardInput): ReportCardRow[] {
  const { candidates, qualifyingEpochs, voteCounts, rationaleCounts, now } = input;
  const minEligible = input.minEligible ?? DEFAULT_MIN_ELIGIBLE;

  const cohort: CohortMember[] = [];
  for (const candidate of candidates) {
    const eligible = countEligible(qualifyingEpochs, candidate.registeredEpoch);
    if (eligible < minEligible) continue;
    const voted = voteCounts.get(candidate.drepId) ?? 0;
    const participationPct = eligible > 0 ? (voted / eligible) * 100 : 0;
    const stats = rationaleCounts.get(candidate.drepId);
    const rationale = stats && stats.total > 0 ? { pct: (stats.withRationale / stats.total) * 100 } : null;
    cohort.push({ drepId: candidate.drepId, eligible, participationPct, rationale });
  }

  const cohortSize = cohort.length;
  const participationAhead = rankAheadPct(cohort, (m) => m.participationPct);

  const rationaleCohort = cohort.filter((m) => m.rationale !== null);
  const rationaleCohortSize = rationaleCohort.length;
  const rationaleAhead = rankAheadPct(rationaleCohort, (m) => m.rationale!.pct);

  return cohort.map((m) => ({
    drepId: m.drepId,
    computedAt: now,
    participationPct: m.participationPct,
    participationAheadPct: participationAhead.get(m) ?? 0,
    rationalePct: m.rationale ? m.rationale.pct : null,
    rationaleAheadPct: m.rationale ? (rationaleAhead.get(m) ?? 0) : null,
    eligible: m.eligible,
    cohortSize,
    rationaleCohortSize,
  }));
}

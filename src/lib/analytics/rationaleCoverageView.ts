// Pure view model for the hub's rationale-coverage panel. Coverage is a
// measurement of anchors on votes, never a quality claim, and the power
// figure only exists over actions whose every vote has a power reading
// (partial power sums must never pose as totals). BigInt for power math,
// the cross-action totals exceed 2^53 lovelace.
import type { ActionRationaleCoverage } from '../db/rationaleCoverage.js';

export interface RationaleCoverageAction {
  gaId: string;
  title: string;
  href: string | null;
  type: string;
  decidedEpoch: number;
  pct: number;
  votes: number;
}

export interface RationaleCoverageView {
  countPct: number | null;
  totalVotes: number;
  totalWithRationale: number;
  powerPct: number | null;
  powerExcluded: number;
  byType: { type: string; medianPct: number; actions: number }[];
  epochSeries: { epoch: number; value: number }[];
  best: RationaleCoverageAction[];
  worst: RationaleCoverageAction[];
  belowFloor: number;
  revoteAdded: number;
}

const VOTE_FLOOR = 20;
const LIST_SIZE = 3;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pct4(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 1_000_000n) / total) / 10_000;
}

const coveragePct = (r: ActionRationaleCoverage): number => (r.votes > 0 ? (r.withRationale / r.votes) * 100 : 0);

export function buildRationaleCoverage(
  rows: ActionRationaleCoverage[],
  revoteAdded: number,
): RationaleCoverageView {
  const voted = rows.filter((r) => r.votes > 0);
  const totalVotes = voted.reduce((n, r) => n + r.votes, 0);
  const totalWithRationale = voted.reduce((n, r) => n + r.withRationale, 0);

  let powerTotal = 0n;
  let powerCovered = 0n;
  let powerActions = 0;
  let powerExcluded = 0;
  for (const r of voted) {
    if (r.power === null || r.powerWithRationale === null) {
      powerExcluded += 1;
      continue;
    }
    try {
      powerTotal += BigInt(r.power);
      powerCovered += BigInt(r.powerWithRationale);
      powerActions += 1;
    } catch {
      powerExcluded += 1;
    }
  }

  const byTypeMap = new Map<string, number[]>();
  for (const r of voted) {
    const list = byTypeMap.get(r.type);
    if (list) list.push(coveragePct(r));
    else byTypeMap.set(r.type, [coveragePct(r)]);
  }
  const byType = [...byTypeMap.entries()]
    .map(([type, pcts]) => ({ type, medianPct: median(pcts) ?? 0, actions: pcts.length }))
    .sort((x, y) => y.medianPct - x.medianPct || x.type.localeCompare(y.type));

  const byEpochMap = new Map<number, number[]>();
  for (const r of voted) {
    const list = byEpochMap.get(r.decidedEpoch);
    if (list) list.push(coveragePct(r));
    else byEpochMap.set(r.decidedEpoch, [coveragePct(r)]);
  }
  const epochSeries = [...byEpochMap.entries()]
    .map(([epoch, pcts]) => ({ epoch, value: median(pcts) ?? 0 }))
    .sort((x, y) => x.epoch - y.epoch);

  const floored = voted.filter((r) => r.votes >= VOTE_FLOOR);
  const toAction = (r: ActionRationaleCoverage): RationaleCoverageAction => ({
    gaId: r.gaId,
    title: r.title ?? r.type,
    href: r.topicSlug != null ? `/t/${r.topicSlug}/` : null,
    type: r.type,
    decidedEpoch: r.decidedEpoch,
    pct: coveragePct(r),
    votes: r.votes,
  });
  const ranked = [...floored].sort(
    (x, y) => coveragePct(y) - coveragePct(x) || x.gaId.localeCompare(y.gaId),
  );
  // Best and worst never overlap, each side takes at most LIST_SIZE and never
  // more than half of the ranked population, so a small population splits
  // cleanly (2 actions = one best, one worst) instead of repeating entries.
  const take = Math.min(LIST_SIZE, Math.floor(ranked.length / 2));

  return {
    countPct: totalVotes > 0 ? (totalWithRationale / totalVotes) * 100 : null,
    totalVotes,
    totalWithRationale,
    powerPct: powerActions > 0 ? pct4(powerCovered, powerTotal) : null,
    powerExcluded,
    byType,
    epochSeries,
    best: ranked.slice(0, take).map(toAction),
    worst: ranked.slice(ranked.length - take).reverse().map(toAction),
    belowFloor: voted.length - floored.length,
    revoteAdded,
  };
}

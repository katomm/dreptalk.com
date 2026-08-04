// Pure view-model math for the DRep voting-stats panel: turns the raw vote
// breakdown into donut arcs and formats the rationale / participation lines.
// Kept out of the .astro component so the arithmetic is unit-tested, mirroring
// the concentrationView.ts split.
import { TONE_COLORS, voteTone } from '../governance/view.js';
import type { DrepVoteBreakdown, DrepRationaleStats, DrepParticipation } from '../db/drepVotes.js';

// Donut geometry, shared with the markup in DrepVotingStats.astro (200x200 viewBox).
export const DONUT_R = 80;
export const DONUT_STROKE = 22;
// Circumference. Exported so the component reuses it for the dash gap instead of
// recomputing it from DONUT_R.
export const DONUT_C = 2 * Math.PI * DONUT_R;

type SliceKey = 'yes' | 'no' | 'abstain';

export interface DonutArc {
  dash: number;
  offset: number;
  color: string;
  key: SliceKey;
}

export interface DonutLegendItem {
  key: SliceKey;
  label: string;
  count: number;
  pct: number;
  color: string;
}

export interface VoteDonut {
  total: number;
  arcs: DonutArc[];
  legend: DonutLegendItem[];
}

const SLICES: { key: SliceKey; label: string }[] = [
  { key: 'yes', label: 'Yes' },
  { key: 'no', label: 'No' },
  { key: 'abstain', label: 'Abstain' },
];

/**
 * Builds donut arcs + legend from a vote breakdown, by raw count (1 action = 1
 * vote). Arcs are drawn clockwise from the top (the markup rotates -90deg); each
 * arc's dashoffset is the negative cumulative start, matching the concentration
 * donut. Zero-count slices are skipped (no zero-length arc) but kept in the
 * legend. Returns empty arcs/legend percentages when the DRep has no votes.
 */
export function buildVoteDonut(b: DrepVoteBreakdown): VoteDonut {
  const arcs: DonutArc[] = [];
  const legend: DonutLegendItem[] = [];
  let start = 0;
  for (const s of SLICES) {
    const count = b[s.key];
    const pct = b.total > 0 ? (count / b.total) * 100 : 0;
    const color = TONE_COLORS[voteTone(s.label)];
    legend.push({ key: s.key, label: s.label, count, pct, color });
    if (count > 0) {
      arcs.push({ dash: (pct / 100) * DONUT_C, offset: -(start / 100) * DONUT_C, color, key: s.key });
      start += pct;
    }
  }
  return { total: b.total, arcs, legend };
}

export interface RationaleStat {
  withRationale: number;
  total: number;
  /** Rounded share of votes carrying a rationale anchor. */
  pct: number;
}

/** Structured rationale stat (counts plus the rounded percent), or null with no votes. */
export function rationaleStat(s: Pick<DrepRationaleStats, 'total' | 'withRationale'>): RationaleStat | null {
  if (s.total === 0) return null;
  return { withRationale: s.withRationale, total: s.total, pct: Math.round((s.withRationale / s.total) * 100) };
}

/**
 * Participation, as a tagged state so the UI renders a percent only when one is
 * meaningful: 'pending' = registration epoch not yet backfilled; 'none' = no
 * concluded actions in the DRep's window yet (never a misleading 0%); 'ok' = a
 * real rate.
 */
export type ParticipationStat =
  | { kind: 'pending' }
  | { kind: 'none' }
  | { kind: 'ok'; voted: number; eligible: number; pct: number };

export function participationStat(p: DrepParticipation | null): ParticipationStat {
  if (p === null) return { kind: 'pending' };
  if (p.eligible === 0) return { kind: 'none' };
  return { kind: 'ok', voted: p.voted, eligible: p.eligible, pct: Math.round((p.voted / p.eligible) * 100) };
}

export interface VoteChangeStat {
  /** Actions where the recorded vote actually switched at least once. */
  actionsChanged: number;
  /** Total number of actual switches across all actions. */
  totalChanges: number;
}

/**
 * Counts real vote switches from the already-loaded re-vote history (the same
 * map that drives the "changed from X" chips, so this costs no extra query).
 * A re-vote that kept the same choice (rationale revision) is deliberately NOT
 * a change: per action the chain oldest-to-newest (superseded votes, newest
 * first in the map, then the current vote) is walked and only adjacent
 * differing pairs count. Null when nothing ever changed, so the UI can omit
 * the line entirely.
 */
export function voteChangeStat(
  earlierByAction: ReadonlyMap<string, { vote: string }[]>,
  currentVoteByAction: ReadonlyMap<string, string>,
): VoteChangeStat | null {
  let actionsChanged = 0;
  let totalChanges = 0;
  for (const [gaId, earlier] of earlierByAction) {
    if (earlier.length === 0) continue;
    const chain = earlier.map((e) => e.vote).reverse();
    const current = currentVoteByAction.get(gaId);
    if (current != null) chain.push(current);
    let changes = 0;
    for (let i = 1; i < chain.length; i++) {
      if (chain[i] !== chain[i - 1]) changes++;
    }
    if (changes > 0) {
      actionsChanged++;
      totalChanges += changes;
    }
  }
  return totalChanges === 0 ? null : { actionsChanged, totalChanges };
}

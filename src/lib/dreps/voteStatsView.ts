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

/** "27 of 41 votes with rationale (66%)", or null when the DRep has no votes. */
export function formatRationale(s: Pick<DrepRationaleStats, 'total' | 'withRationale'>): string | null {
  if (s.total === 0) return null;
  const pct = Math.round((s.withRationale / s.total) * 100);
  return `${s.withRationale} of ${s.total} votes with rationale (${pct}%)`;
}

/**
 * Participation line. null = registration epoch not yet backfilled (pending);
 * eligible 0 = no concluded actions in the DRep's window yet. Never shows 0%.
 */
export function formatParticipation(p: DrepParticipation | null): string {
  if (p === null) return 'Registration date pending';
  if (p.eligible === 0) return 'No concluded governance actions yet';
  const pct = Math.round((p.voted / p.eligible) * 100);
  return `Voted on ${p.voted} of ${p.eligible} eligible actions (${pct}%)`;
}

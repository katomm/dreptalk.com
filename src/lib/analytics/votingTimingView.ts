// Pure view model for the analytics hub's network-wide voting-timing panel:
// overall DRep vs SPO median day-to-vote, an early/middle/late split of the
// voting window (plus how many votes arrive after the window closes), the
// half-turnout median day, and a per-type DRep vs SPO median breakdown. All
// inputs are D1 reads already computed by recordDiagnostics.ts, this module
// only shapes them, no I/O.
import type { NetworkOverallTiming, NetworkTypeTiming, WindowThirds } from '../db/recordDiagnostics.js';

export interface TypeTimingRow {
  type: string;
  drepMedianDay: number;
  drepTimed: number;
  spoMedianDay: number | null;
}

export interface VotingTimingView {
  drepMedianDay: number | null;
  drepTimed: number;
  spoMedianDay: number | null;
  spoTimed: number;
  thirds: WindowThirds;
  halfTurnoutMedianDay: number | null;
  halfBasis: number;
  byType: TypeTimingRow[];
}

export interface BuildVotingTimingInput {
  drepByType: NetworkTypeTiming[];
  spoByType: NetworkTypeTiming[];
  drepOverall: NetworkOverallTiming | null;
  spoOverall: NetworkOverallTiming | null;
  /** Half-turnout median across decided actions, already reduced by the snapshot reducer. */
  half: { medianDay: number | null; basis: number };
  thirds: WindowThirds;
}

const MIN_TYPE_TIMED_VOTES = 20;

/**
 * Network-wide voting timing: overall DRep vs SPO median day-to-vote (null
 * when a role has no timed votes at all), the early/middle/late window
 * thirds passed through unchanged, the half-turnout median day across
 * decided actions, and a per-type breakdown.
 *
 * byType keeps only types with at least MIN_TYPE_TIMED_VOTES timed DRep
 * votes, a per-type figure below that floor is too noisy to show. The SPO
 * median for the same type name is joined under the same floor on the SPO
 * side (null when that row is missing or thinner, since SPOs vote far less
 * often than DReps and an unfiltered join would show low-sample medians).
 * Sorted by drepTimed descending, then type ascending.
 */
export function buildVotingTiming(input: BuildVotingTimingInput): VotingTimingView {
  const spoByType = new Map(input.spoByType.map((t) => [t.type, t]));
  const byType: TypeTimingRow[] = input.drepByType
    .filter((t) => t.timedVotes >= MIN_TYPE_TIMED_VOTES)
    .map((t) => {
      const spo = spoByType.get(t.type);
      return {
        type: t.type,
        drepMedianDay: t.medianDay,
        drepTimed: t.timedVotes,
        spoMedianDay: spo && spo.timedVotes >= MIN_TYPE_TIMED_VOTES ? spo.medianDay : null,
      };
    })
    .sort((a, b) => b.drepTimed - a.drepTimed || a.type.localeCompare(b.type));

  return {
    drepMedianDay: input.drepOverall?.medianDay ?? null,
    drepTimed: input.drepOverall?.timedVotes ?? 0,
    spoMedianDay: input.spoOverall?.medianDay ?? null,
    spoTimed: input.spoOverall?.timedVotes ?? 0,
    thirds: input.thirds,
    halfTurnoutMedianDay: input.half.medianDay,
    halfBasis: input.half.basis,
    byType,
  };
}

/**
 * The empty view, for a render with no database binding at all. Frozen because
 * it is a shared module-level singleton: without this one page could mutate what
 * another renders.
 */
export const EMPTY_TIMING_VIEW: VotingTimingView = Object.freeze(
  buildVotingTiming({
    drepByType: [],
    spoByType: [],
    drepOverall: null,
    spoOverall: null,
    half: { medianDay: null, basis: 0 },
    thirds: { early: 0, middle: 0, late: 0, afterClose: 0, basis: 0 },
  }),
);

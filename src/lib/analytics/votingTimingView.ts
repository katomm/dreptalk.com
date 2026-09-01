// Pure view model for the analytics hub's network-wide voting-timing panel:
// overall DRep vs SPO median day-to-vote, an early/middle/late split of the
// voting window (plus how many votes land after the window closes), the
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
  /** Raw half-turnout day values, one per decided action, median computed here. */
  halfDays: number[];
  thirds: WindowThirds;
}

const MIN_TYPE_TIMED_VOTES = 20;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Network-wide voting timing: overall DRep vs SPO median day-to-vote (null
 * when a role has no timed votes at all), the early/middle/late window
 * thirds passed through unchanged, the half-turnout median day across
 * decided actions, and a per-type breakdown.
 *
 * byType keeps only types with at least MIN_TYPE_TIMED_VOTES timed DRep
 * votes (a per-type figure below that floor is too noisy to show), joins the
 * SPO median for the same type name subject to the same MIN_TYPE_TIMED_VOTES
 * floor on the SPO side (null when the SPO type row is absent or has fewer
 * than MIN_TYPE_TIMED_VOTES timed votes, since SPOs vote far less often than
 * DReps and an unfiltered join would show noisy low-sample medians), sorted
 * by drepTimed descending then type ascending.
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
    halfTurnoutMedianDay: median(input.halfDays),
    halfBasis: input.halfDays.length,
    byType,
  };
}

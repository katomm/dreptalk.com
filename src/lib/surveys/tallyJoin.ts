// Joining the two stored tally runs of one survey question. Pure arithmetic over
// the cip-179 shapes, extracted out of SurveyTally.astro because Biome does not
// lint .astro and astro check only typechecks it, so this is the only place the
// join can carry tests.
//
// Why two runs exist at all, and why they must be joined rather than one of them
// read: the runs differ in their responder SET. A counted DRep whose credential
// has no row in drep_voting_power_history is absent from the weighted run by
// design, so reading an option's count or a question's answered count out of the
// weighted run would make that answer vanish from its own option and reappear as
// an abstention nobody made.

import type { ArtifactQuestion } from 'cip-179/tally';
import type { BarView } from './tallyView.js';

/**
 * Give the two runs the same populated index set.
 *
 * questionView fills every declared option and then appends any answered index
 * beyond that, so two runs that answered different indices produce two
 * differently shaped lists, and reading one against the other by position would
 * pair an option with another option's count. Injecting the union of both index
 * sets into both questions makes position `i` the same option index in both.
 *
 * An injected entry renders exactly as a missing one: no weight, no count, and
 * no mean, since its own denominator is zero. It cannot move a figure either,
 * because a zero weight changes neither a sum, nor a maximum, nor the
 * single-choice denominator, which is the question-level answered weight.
 *
 * Numeric questions are deliberately left alone: their buckets are per answered
 * value, and an injected zero-weight bucket can move the weighted median, which
 * walks the bins accumulating weight. Those runs go through
 * {@link joinNumericBins} instead, which joins on the value.
 */
export function alignIndices(
  w: ArtifactQuestion,
  h: ArtifactQuestion,
): [ArtifactQuestion, ArtifactQuestion] {
  if (w.kind === 'options' && h.kind === 'options') {
    const all = [...new Set([...w.options.map(o => o.index), ...h.options.map(o => o.index)])];
    const fill = (q: typeof w): typeof w => {
      const have = new Set(q.options.map(o => o.index));
      const extra = all.filter(i => !have.has(i)).map(index => ({ index, weight: '0', count: 0 }));
      if (extra.length === 0) return q;
      return { ...q, options: [...q.options, ...extra].sort((a, b) => a.index - b.index) };
    };
    return [fill(w), fill(h)];
  }
  if (w.kind === 'perOption' && h.kind === 'perOption') {
    const all = [...new Set([...w.perOption.map(o => o.index), ...h.perOption.map(o => o.index)])];
    const fill = (q: typeof w): typeof w => {
      const have = new Set(q.perOption.map(o => o.index));
      const extra = all
        .filter(i => !have.has(i))
        .map(index => ({ index, weightedSum: '0', answeredWeight: '0', count: 0 }));
      if (extra.length === 0) return q;
      return { ...q, perOption: [...q.perOption, ...extra].sort((a, b) => a.index - b.index) };
    };
    return [fill(w), fill(h)];
  }
  return [w, h];
}

/** One numeric value with the shown run's bar and the head-count run's count. */
export interface JoinedBin {
  /** The answered value, in the decimal string form the artifact committed. */
  value: string;
  /** Fill fraction of the shown run, 0 for a value only the other run saw. */
  frac: number;
  /** Weight behind the value in the shown run, 0n when it did not see it. */
  weight: bigint;
  /** Head count for the value, null when no head count can be claimed. */
  count: number | null;
}

/**
 * Join the two numeric runs on the answered value, not by position: each run
 * buckets whatever values its own responders gave, so the two lists are
 * genuinely different shapes and neither is a prefix of the other. Every value
 * either run saw is rendered, so a value answered only by a DRep that could not
 * be weighted still shows its head count beside an empty bar.
 *
 * `shownIsWeighted` says whether `shown` is the weighted run. It is, and only
 * it: with no head-count bin for a value, a weighted run has no head count to
 * claim (null), while the head-count run is its own count.
 */
export function joinNumericBins(
  shown: readonly BarView[],
  headcount: readonly BarView[] | null,
  shownIsWeighted: boolean,
): JoinedBin[] {
  const byValue = new Map(shown.map(b => [b.label, b]));
  const countByValue = new Map((headcount ?? []).map(b => [b.label, b.count]));
  const values = [...new Set([...byValue.keys(), ...countByValue.keys()])].sort(
    (a, b) => Number(a) - Number(b),
  );
  return values.map(value => {
    const bin = byValue.get(value);
    const count = countByValue.get(value) ?? (shownIsWeighted ? null : (bin?.count ?? 0));
    return {
      value,
      frac: bin?.frac ?? 0,
      weight: bin?.weight ?? 0n,
      count,
    };
  });
}

/**
 * How many counted responses left a question unanswered. `answeredCount` must
 * come from the head-count run: the weighted run is short of every counted DRep
 * whose voting power could not be resolved, and subtracting it would invent an
 * abstention for each of them. Clamped at zero because the two figures can come
 * from different sets on a sealed survey, where the head counts are the tally
 * artifact's own post-membership set.
 */
export function abstentions(counted: number, answeredCount: number): number {
  return Math.max(0, counted - answeredCount);
}

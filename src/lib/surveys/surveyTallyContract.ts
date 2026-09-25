// The binding contract for how each survey question kind may be drawn on the
// survey tally card: which bar basis it uses, what the figure beside a bar
// reads, and whether that deliberately diverges from Tessera's own results
// view. SurveyTally.astro reads it, and a consumer that disagrees with it is
// wrong. What the numeric survey_tally figures mean is documented where they
// are computed, in src/lib/surveys/tallyCompute.ts.

/**
 * How a question's bar is drawn. `share-of-answered` is the only basis with a
 * denominator, and it applies to single choice alone, where the shares sum to
 * one whole. Everything else is a comparison, not a share, which is why those
 * kinds show absolute figures instead of percentages.
 */
export type BarBasis = 'share-of-answered' | 'relative-to-leader' | 'within-scale' | 'none';

export interface QuestionKindDisplay {
  /** The cip-179 ArtifactQuestion kind this row projects from. */
  artifactKind: 'options' | 'perOption' | 'numeric' | 'custom';
  barBasis: BarBasis;
  /** What the figure beside a bar reads, in plain words. */
  figure: string;
  /**
   * True where our basis deliberately differs from Tessera's own results view,
   * which fills every bar relative to the leading one and shows no percentage
   * anywhere. Set only on single choice, by the user's decision of 2026-09-11.
   * Do not "fix" a divergence marked here without reading the design doc.
   */
  divergesFromUpstream: boolean;
  /** Why this basis and not another. Read before changing one. */
  reason: string;
}

export type QuestionDisplayKey =
  | 'singleChoice'
  | 'multiSelect'
  | 'rankingFirst'
  | 'rating'
  | 'points'
  | 'numeric'
  | 'custom';

export const QUESTION_KIND_DISPLAY: Record<QuestionDisplayKey, QuestionKindDisplay> = {
  singleChoice: {
    artifactKind: 'options',
    barBasis: 'share-of-answered',
    figure: 'the share, its denominator, the ada behind it and the head count',
    divergesFromUpstream: true,
    reason:
      'One choice per responder, so the shares sum to one whole and a percentage cannot be misread. The only kind where a denominator is both available and unambiguous.',
  },
  multiSelect: {
    artifactKind: 'options',
    barBasis: 'relative-to-leader',
    figure: 'the ada behind it and the head count, labelled as responders',
    divergesFromUpstream: false,
    reason:
      'A responder may select several options, so shares of answering power do not sum to one whole. A percentage here invites the reader to add them up.',
  },
  rankingFirst: {
    artifactKind: 'options',
    barBasis: 'relative-to-leader',
    figure: 'the ada behind it and the head count, labelled as first preferences only',
    divergesFromUpstream: false,
    reason:
      'The committed tally carries first preferences alone, not the full ranking, so any percentage would describe less than the question asked.',
  },
  rating: {
    artifactKind: 'perOption',
    barBasis: 'within-scale',
    figure: "the weighted mean, with the scale's own level label where it has one",
    divergesFromUpstream: false,
    reason:
      "Each option commits its own denominator, because each option's raters differ. The means are therefore not comparable as parts of one whole, so the bar is positioned within the scale span the definition declares.",
  },
  points: {
    artifactKind: 'perOption',
    barBasis: 'relative-to-leader',
    figure: 'the weighted mean allocation, which is not a share of anything',
    divergesFromUpstream: false,
    reason:
      'Points omits the per-option denominator because it equals the question-level answered weight. The figure is a mean allocation, so it is normalised against the leading option to make the bars comparable.',
  },
  numeric: {
    artifactKind: 'numeric',
    barBasis: 'relative-to-leader',
    figure: 'the weighted mean and the weighted median, over a per-value histogram',
    divergesFromUpstream: false,
    reason:
      'A numeric answer has no options to take shares of. The distribution is the answer, and the two central figures summarise it.',
  },
  custom: {
    artifactKind: 'custom',
    barBasis: 'none',
    figure: 'participation only',
    divergesFromUpstream: false,
    reason:
      'Free-form answers aggregate to participation and nothing else. Showing verbatim text is out of scope, since it is untrusted input on a cached page.',
  },
};

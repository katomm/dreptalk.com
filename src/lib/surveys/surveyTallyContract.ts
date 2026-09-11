// The binding contract for survey_tally: what every column means, where its
// value comes from, and on what basis each question kind may be drawn. The
// table's own comments point here, and a consumer that disagrees with this file
// is wrong. Same role as src/lib/analytics/epochStatsContract.ts, and the same
// reason: a JSON blob plus a handful of integers is exactly where settled
// semantics rot if they are not written down next to the code that reads them.

/** Where a stored figure comes from. */
export type SurveyTallyMetricSource =
  /** Our own cip-179 audit of the response bundle, at unit weight. */
  | 'audit-unit'
  /** Our own audit, weighted with local per-epoch DRep voting power. */
  | 'audit-weighted'
  /** The survey's hash-committed tally artifact, weighted at its end_epoch. */
  | 'artifact'
  /** The local DRep power history and the epoch aggregates over it. */
  | 'local-power';

export interface SurveyTallyMetric {
  /** Column in survey_tally. Static, never user input. */
  column: string;
  source: SurveyTallyMetricSource;
  /** Whether the special auto-voting ids are part of the value. */
  includesSpecials: boolean;
  /** One sentence, suitable as a footnote under the figure. */
  definition: string;
}

export type SurveyTallyMetricKey =
  | 'counted'
  | 'matchedCount'
  | 'answeredPower'
  | 'totalPower'
  | 'excluded'
  | 'powerEpoch';

export const SURVEY_TALLY_METRICS: Record<SurveyTallyMetricKey, SurveyTallyMetric> = {
  counted: {
    column: 'counted',
    source: 'audit-unit',
    includesSpecials: false,
    definition:
      'Responses claiming role DRep that the cip-179 audit counted: in window, valid against the definition, credential proof not refuted, and the latest per credential. The head count of record, and the only figure that survives when a responder cannot be weighted.',
  },
  matchedCount: {
    column: 'matched_count',
    source: 'audit-weighted',
    includesSpecials: false,
    definition:
      'Counted responses that were given a weight, zero weight included. A DRep registered with no power is matched and weighs nothing, so this figure must never be described as the responses that carry voting power.',
  },
  answeredPower: {
    column: 'answered_power',
    source: 'audit-weighted',
    includesSpecials: false,
    definition:
      'Summed voting power in lovelace of the matched responders at power_epoch. The denominator of every single-choice share, and the turnout numerator. May legitimately be zero.',
  },
  totalPower: {
    column: 'total_power',
    source: 'local-power',
    includesSpecials: false,
    definition:
      'Representative DRep voting power in lovelace at power_epoch, from governance_epoch_stats.total_drep_power, which excludes the two auto-voting special ids. The turnout denominator, and null when the epoch has no row, never zero.',
  },
  excluded: {
    column: 'excluded',
    source: 'audit-unit',
    includesSpecials: false,
    definition:
      'Responses claiming role DRep that the audit did not count, whatever the reason. The claimed role is used because a response can be excluded precisely for naming an ineligible role, and a claim is the only role such a record has.',
  },
  powerEpoch: {
    column: 'power_epoch',
    source: 'local-power',
    includesSpecials: false,
    definition:
      "The epoch the weights were snapshotted at: the newest epoch in drep_voting_power_history on the live path, and the survey's end_epoch on the artifact path. Taken from the same table the weights come from, so the stated basis and the weights cannot disagree.",
  },
};

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

// The binding contract for the six survey_tally figures a reader is shown: what
// each means, where its value comes from, and on what basis each question kind
// may be drawn. Not every column of the table, which has fifteen: the bookkeeping
// ones (the two source flags, the artifact hash, the two stamps, the questions
// blob itself) are documented on the table, in migrations/0099_survey_tally.sql.
// For the six below this file is binding, and a consumer that disagrees with it
// is wrong. Same role as src/lib/analytics/epochStatsContract.ts, and the same
// reason: a JSON blob plus a handful of integers is exactly where settled
// semantics rot if they are not written down next to the code that reads them.
//
// FOUR of the six figures here have two paths, live and artifact, and for those
// four a definition that describes only the live one is drift, not brevity: see
// src/lib/surveys/tallyCompute.ts, where the artifact substitutes its own value
// for matched_count, answered_power, total_power and power_epoch. The other two,
// counted and excluded, are this site's own audit of the response bundle on both
// paths, so they have one source and one definition. surveyTallyContract.test.ts
// holds each of the four to naming both paths, in its text and in its source.

/** Where a stored figure comes from on one path. */
export type SurveyTallyMetricSource =
  /** Our own cip-179 audit of the response bundle, at unit weight. */
  | 'audit-unit'
  /** Our own audit, weighted with local per-epoch DRep voting power. */
  | 'audit-weighted'
  /** The survey's hash-committed tally artifact, weighted at its end_epoch. */
  | 'artifact'
  /** The local DRep power history and the epoch aggregates over it. */
  | 'local-power';

/**
 * Where a figure comes from on each path. One source per metric cannot state the
 * truth for a figure tallyCompute substitutes, and that is exactly how the
 * earlier drift survived: four of these read 'audit-weighted' or 'local-power'
 * while the artifact path had already replaced the value, and the 'artifact'
 * source was named by no metric at all. The audit-only figures name the same
 * source twice, which is the shape that says this one does not depend on the
 * path.
 */
export interface SurveyTallyMetricSources {
  live: SurveyTallyMetricSource;
  artifact: SurveyTallyMetricSource;
}

export interface SurveyTallyMetric {
  /** Column in survey_tally. Static, never user input. */
  column: string;
  source: SurveyTallyMetricSources;
  /**
   * Whether the special auto-voting ids are part of the value. A boolean cannot
   * say "unknown", so where the answer differs by path the definition text is the
   * authority and this flag states the live path only. totalPower is the one
   * figure that happens in: on the artifact path the value is the artifact's own
   * electorate total, whose treatment of the two special ids this site does not
   * know and must not assert.
   */
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
    source: { live: 'audit-unit', artifact: 'audit-unit' },
    includesSpecials: false,
    definition:
      'Responses claiming role DRep that the cip-179 audit counted: in window, valid against the definition, credential proof not refuted, and the latest per credential. The head count of record, and the only figure that survives when a responder cannot be weighted.',
  },
  matchedCount: {
    column: 'matched_count',
    source: { live: 'audit-weighted', artifact: 'artifact' },
    includesSpecials: false,
    definition:
      'On the live path, counted responses that were given a weight, zero weight included. A DRep registered with no power is matched and weighs nothing, so this figure must never be described as the responses that carry voting power. On the artifact path it is the number of responders the published tally artifact committed for the DRep role, which additionally requires DRep membership at the end epoch, so it is normally lower than the counted head count.',
  },
  answeredPower: {
    column: 'answered_power',
    source: { live: 'audit-weighted', artifact: 'artifact' },
    includesSpecials: false,
    definition:
      'On the live path, summed voting power in lovelace of the matched responders at power_epoch. On the artifact path, the sum of the weights the published tally artifact committed for its own responders, at the end epoch it was weighted at. Summed over responders in both cases, never reduced out of the questions: each question commits its own answered weight, so two responders answering two different optional questions give question weights whose maximum is smaller than the participating power. The turnout numerator, and the single-choice share divides by its own question answered weight rather than by this. May legitimately be zero.',
  },
  totalPower: {
    column: 'total_power',
    source: { live: 'local-power', artifact: 'artifact' },
    includesSpecials: false,
    definition:
      'On the live path, representative DRep voting power in lovelace at power_epoch, from governance_epoch_stats.total_drep_power, which excludes the two auto-voting special ids, so includesSpecials above holds for this path. On the artifact path it is the DRep electorate total the published tally artifact committed at the end epoch, and whether that total counts the two special ids is the artifact author\'s decision, unknown to this site and never to be asserted either way: the card names it as the artifact\'s own total instead of repeating the live basis. The turnout denominator, and null when the epoch has no row, never zero.',
  },
  excluded: {
    column: 'excluded',
    source: { live: 'audit-unit', artifact: 'audit-unit' },
    includesSpecials: false,
    definition:
      'Responses claiming role DRep that the audit did not count, whatever the reason. The claimed role is used because a response can be excluded precisely for naming an ineligible role, and a claim is the only role such a record has.',
  },
  powerEpoch: {
    column: 'power_epoch',
    source: { live: 'local-power', artifact: 'artifact' },
    includesSpecials: false,
    definition:
      "The epoch the weights were snapshotted at: the newest epoch in drep_voting_power_history on the live path, and the survey's end_epoch as the published tally artifact's own body states it on the artifact path. On the live path it is read from the same table the weights come from, so the stated basis and the weights cannot disagree. On the artifact path no table is read for it at all, and the epoch and the weights are both the artifact's own, so those two cannot disagree either.",
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

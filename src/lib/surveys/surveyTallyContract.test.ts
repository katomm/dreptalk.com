import { describe, expect, it } from 'vitest';
import { QUESTION_KIND_DISPLAY, SURVEY_TALLY_METRICS } from './surveyTallyContract.js';

describe('survey tally contract', () => {
  it('gives every metric a definition, a source and a denominator statement', () => {
    for (const [key, m] of Object.entries(SURVEY_TALLY_METRICS)) {
      expect(m.column, key).toBeTruthy();
      expect(m.definition.length, key).toBeGreaterThan(20);
      expect(m.source, key).toBeTruthy();
    }
  });

  it('states that matched_count includes zero weight, so no copy may call it carried power', () => {
    expect(SURVEY_TALLY_METRICS.matchedCount.definition).toMatch(/zero weight/i);
    expect(SURVEY_TALLY_METRICS.matchedCount.definition).not.toMatch(/carries voting power/i);
  });

  it('records that the turnout denominator excludes the special auto-voting ids', () => {
    expect(SURVEY_TALLY_METRICS.totalPower.includesSpecials).toBe(false);
  });

  it('uses a share basis for single choice only', () => {
    expect(QUESTION_KIND_DISPLAY.singleChoice.barBasis).toBe('share-of-answered');
    expect(QUESTION_KIND_DISPLAY.multiSelect.barBasis).toBe('relative-to-leader');
    expect(QUESTION_KIND_DISPLAY.rankingFirst.barBasis).toBe('relative-to-leader');
    expect(QUESTION_KIND_DISPLAY.points.barBasis).toBe('relative-to-leader');
    expect(QUESTION_KIND_DISPLAY.rating.barBasis).toBe('within-scale');
    expect(QUESTION_KIND_DISPLAY.custom.barBasis).toBe('none');
  });

  it('marks the single-choice basis as a deliberate divergence from upstream', () => {
    expect(QUESTION_KIND_DISPLAY.singleChoice.divergesFromUpstream).toBe(true);
    expect(QUESTION_KIND_DISPLAY.multiSelect.divergesFromUpstream).toBe(false);
  });

  it('never promises a share for a kind whose weightedSum is not a share', () => {
    for (const key of ['points', 'rating', 'numeric'] as const) {
      expect(QUESTION_KIND_DISPLAY[key].barBasis, key).not.toBe('share-of-answered');
    }
  });
});

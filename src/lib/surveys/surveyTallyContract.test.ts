import { describe, expect, it } from 'vitest';
import { QUESTION_KIND_DISPLAY, SURVEY_TALLY_METRICS } from './surveyTallyContract.js';

describe('survey tally contract', () => {
  it('gives every metric a definition, a source and a denominator statement', () => {
    for (const [key, m] of Object.entries(SURVEY_TALLY_METRICS)) {
      expect(m.column, key).toBeTruthy();
      expect(m.definition.length, key).toBeGreaterThan(20);
      expect(m.source.live, key).toBeTruthy();
      expect(m.source.artifact, key).toBeTruthy();
    }
  });

  // The structured field drifted the same way the definition texts had: all four
  // of these said where the LIVE value comes from while tallyCompute substitutes
  // an artifact value, and the 'artifact' source was carried by no metric at all.
  // A truthy check cannot see that, so each path is asserted by name here.
  it('names the artifact as the source of every figure the artifact path substitutes', () => {
    for (const key of ['matchedCount', 'answeredPower', 'totalPower', 'powerEpoch'] as const) {
      const s = SURVEY_TALLY_METRICS[key].source;
      expect(s.artifact, key).toBe('artifact');
      expect(s.live, key).not.toBe('artifact');
    }
  });

  it('keeps the audit-only figures on one source, since neither path changes them', () => {
    for (const key of ['counted', 'excluded'] as const) {
      const s = SURVEY_TALLY_METRICS[key].source;
      expect(s.live, key).toBe('audit-unit');
      expect(s.artifact, key).toBe('audit-unit');
    }
  });

  it('states that matched_count includes zero weight, so no copy may call it carried power', () => {
    expect(SURVEY_TALLY_METRICS.matchedCount.definition).toMatch(/zero weight/i);
    expect(SURVEY_TALLY_METRICS.matchedCount.definition).not.toMatch(/carries voting power/i);
  });

  it('records that the turnout denominator excludes the special auto-voting ids', () => {
    expect(SURVEY_TALLY_METRICS.totalPower.includesSpecials).toBe(false);
  });

  // The drift this guards against actually happened: three of these four
  // definitions described the live path alone while tallyCompute substitutes an
  // artifact value for each of them, so the binding contract asserted figures the
  // artifact path does not produce. A definition that names only one path is the
  // exact shape of that bug, so each is held to naming both.
  it('defines every path-dependent figure on the artifact path as well as the live one', () => {
    for (const key of ['matchedCount', 'answeredPower', 'totalPower', 'powerEpoch'] as const) {
      const d = SURVEY_TALLY_METRICS[key].definition;
      expect(d, key).toMatch(/artifact/i);
      expect(d, key).toMatch(/live path|power_epoch|drep_voting_power_history/i);
    }
  });

  it('leaves the specials claim on the live path only, since the artifact total is not ours to assert', () => {
    const d = SURVEY_TALLY_METRICS.totalPower.definition;
    // The flag cannot express "unknown on one path", so the definition has to.
    expect(d).toMatch(/this path/i);
    expect(d).toMatch(/unknown to this site/i);
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

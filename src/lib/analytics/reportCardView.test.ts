import { describe, expect, it } from 'vitest';
import { computeReportCards } from './reportCardView.js';

const NOW = 1_700_000_000_000;

describe('computeReportCards', () => {
  it('ranks three cohort members at 100/50/0 participation into 66/33/0 ahead', () => {
    // Core case: three cohort members with participation 100 / 50 / 0:
    // aheadPct = floor(100 * strictlyBelow / 3) -> 66 / 33 / 0.
    const rows = computeReportCards({
      candidates: [
        { drepId: 'full', registeredEpoch: 500 },
        { drepId: 'half', registeredEpoch: 500 },
        { drepId: 'none', registeredEpoch: 500 },
      ],
      qualifyingEpochs: [500, 501],
      voteCounts: new Map([
        ['full', 2],
        ['half', 1],
        ['none', 0],
      ]),
      rationaleCounts: new Map(),
      now: NOW,
      minEligible: 2,
    });
    const byId = new Map(rows.map((r) => [r.drepId, r]));
    expect(byId.get('full')?.participationPct).toBe(100);
    expect(byId.get('full')?.participationAheadPct).toBe(66);
    expect(byId.get('half')?.participationPct).toBe(50);
    expect(byId.get('half')?.participationAheadPct).toBe(33);
    expect(byId.get('none')?.participationPct).toBe(0);
    expect(byId.get('none')?.participationAheadPct).toBe(0);
  });

  it('gives tied members the same aheadPct as each other', () => {
    // Ties: two members at 50 and one at 0 -> both 50s get aheadPct 33, the
    // 0 gets 0.
    const rows = computeReportCards({
      candidates: [
        { drepId: 'tiedA', registeredEpoch: 500 },
        { drepId: 'tiedB', registeredEpoch: 500 },
        { drepId: 'zero', registeredEpoch: 500 },
      ],
      qualifyingEpochs: [500, 501],
      voteCounts: new Map([
        ['tiedA', 1],
        ['tiedB', 1],
        ['zero', 0],
      ]),
      rationaleCounts: new Map(),
      now: NOW,
      minEligible: 2,
    });
    const byId = new Map(rows.map((r) => [r.drepId, r]));
    expect(byId.get('tiedA')?.participationAheadPct).toBe(33);
    expect(byId.get('tiedB')?.participationAheadPct).toBe(33);
    expect(byId.get('zero')?.participationAheadPct).toBe(0);
  });

  it('excludes a candidate below minEligible entirely and shrinks cohortSize', () => {
    // minEligible: candidate with eligible 4 (registered late) excluded
    // entirely, cohortSize reflects it.
    const rows = computeReportCards({
      candidates: [
        { drepId: 'lateRegistrant', registeredEpoch: 501 },
        { drepId: 'earlyRegistrant', registeredEpoch: 500 },
      ],
      qualifyingEpochs: [500, 501, 502, 503, 504],
      voteCounts: new Map(),
      rationaleCounts: new Map(),
      now: NOW,
    });
    expect(rows.find((r) => r.drepId === 'lateRegistrant')).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0].drepId).toBe('earlyRegistrant');
    expect(rows[0].cohortSize).toBe(1);
  });

  it('derives eligible as the count of qualifying epochs at or after registration', () => {
    // eligible derivation: qualifyingEpochs [600,601,602,610], registeredEpoch
    // 602 -> eligible 2 (602 and 610).
    const rows = computeReportCards({
      candidates: [{ drepId: 'drep1', registeredEpoch: 602 }],
      qualifyingEpochs: [600, 601, 602, 610],
      voteCounts: new Map([['drep1', 1]]),
      rationaleCounts: new Map(),
      now: NOW,
      minEligible: 1,
    });
    expect(rows[0].eligible).toBe(2);
  });

  it('nulls out rationale fields for a member with zero votes and excludes them from rationaleCohortSize', () => {
    // Rationale: member with zero votes -> rationalePct/rationaleAheadPct
    // null, rationaleCohortSize excludes them.
    const rows = computeReportCards({
      candidates: [
        { drepId: 'voterA', registeredEpoch: 500 },
        { drepId: 'voterB', registeredEpoch: 500 },
        { drepId: 'silent', registeredEpoch: 500 },
      ],
      qualifyingEpochs: [500, 501, 502, 503, 504],
      voteCounts: new Map([
        ['voterA', 3],
        ['voterB', 2],
        ['silent', 0],
      ]),
      rationaleCounts: new Map([
        ['voterA', { total: 3, withRationale: 2 }],
        ['voterB', { total: 2, withRationale: 1 }],
      ]),
      now: NOW,
    });
    const byId = new Map(rows.map((r) => [r.drepId, r]));
    expect(byId.get('silent')?.rationalePct).toBeNull();
    expect(byId.get('silent')?.rationaleAheadPct).toBeNull();
    expect(byId.get('voterA')?.rationaleCohortSize).toBe(2);
    expect(byId.get('silent')?.rationaleCohortSize).toBe(2);
  });

  it('ranks rationale coverage independently of participation', () => {
    // Rationale ranking independent of participation ranking.
    const rows = computeReportCards({
      candidates: [
        { drepId: 'highParticipationLowRationale', registeredEpoch: 500 },
        { drepId: 'lowParticipationHighRationale', registeredEpoch: 500 },
        { drepId: 'middling', registeredEpoch: 500 },
      ],
      qualifyingEpochs: [500, 501, 502, 503, 504],
      voteCounts: new Map([
        ['highParticipationLowRationale', 5],
        ['lowParticipationHighRationale', 1],
        ['middling', 3],
      ]),
      rationaleCounts: new Map([
        ['highParticipationLowRationale', { total: 5, withRationale: 1 }],
        ['lowParticipationHighRationale', { total: 1, withRationale: 1 }],
        ['middling', { total: 3, withRationale: 2 }],
      ]),
      now: NOW,
    });
    const byId = new Map(rows.map((r) => [r.drepId, r]));
    expect(byId.get('highParticipationLowRationale')?.participationAheadPct).toBe(66);
    expect(byId.get('highParticipationLowRationale')?.rationaleAheadPct).toBe(0);
    expect(byId.get('lowParticipationHighRationale')?.participationAheadPct).toBe(0);
    expect(byId.get('lowParticipationHighRationale')?.rationaleAheadPct).toBe(66);
    expect(byId.get('middling')?.participationAheadPct).toBe(33);
    expect(byId.get('middling')?.rationaleAheadPct).toBe(33);
  });

  it('returns an empty list for empty candidates', () => {
    // Empty candidates -> [].
    const rows = computeReportCards({
      candidates: [],
      qualifyingEpochs: [],
      voteCounts: new Map(),
      rationaleCounts: new Map(),
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it('still ranks a candidate absent from voteCounts as having voted 0', () => {
    // A candidate absent from voteCounts has voted 0 (participation 0),
    // still ranked.
    const rows = computeReportCards({
      candidates: [
        { drepId: 'present', registeredEpoch: 500 },
        { drepId: 'absent', registeredEpoch: 500 },
      ],
      qualifyingEpochs: [500, 501, 502, 503, 504],
      voteCounts: new Map([['present', 5]]),
      rationaleCounts: new Map(),
      now: NOW,
    });
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.drepId, r]));
    expect(byId.get('absent')?.participationPct).toBe(0);
    expect(byId.get('absent')?.participationAheadPct).toBe(0);
    expect(byId.get('present')?.participationPct).toBe(100);
    expect(byId.get('present')?.participationAheadPct).toBe(50);
  });
});

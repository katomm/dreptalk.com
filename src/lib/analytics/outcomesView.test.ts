import { describe, expect, it } from 'vitest';
import type { DecidedOutcomeRow } from '../db/hubOutcomes.js';
import { buildSpoSnapshot, buildThroughput } from './outcomesView.js';

const thresholds = (over: { drep?: number | null; spo?: number | null } = {}) =>
  JSON.stringify({ drep: 67, spo: 51, cc: 60, ccBelowMinSize: false, v: 2, ...over });

const row = (over: Partial<DecidedOutcomeRow> = {}): DecidedOutcomeRow => ({
  gaId: 'ga1',
  type: 'ParameterChange',
  status: 'enacted',
  submittedEpoch: 600,
  decidedEpoch: 605,
  thresholdsJson: thresholds(),
  drepYesPct: 80,
  spoYesPct: 60,
  spoYesPower: 100,
  spoNoPower: 20,
  spoAbstainPower: 5,
  spoAlwaysAbstainPower: '10',
  spoNoSidePower: '30',
  ...over,
});

describe('buildSpoSnapshot', () => {
  it('returns all zeros and nulls for empty input', () => {
    expect(buildSpoSnapshot([])).toEqual({
      eligible: 0,
      medianTurnoutPct: null,
      turnoutBasis: 0,
      turnoutExcluded: 0,
      divergent: 0,
      divergenceBasis: 0,
    });
  });

  it('counts SPO eligibility from the frozen threshold snapshot', () => {
    const v = buildSpoSnapshot([
      row({ gaId: 'ga1', thresholdsJson: thresholds({ spo: 51 }) }),
      row({ gaId: 'ga2', thresholdsJson: thresholds({ spo: null }) }),
    ]);
    expect(v.eligible).toBe(1);
  });

  it('computes turnout with BigInt across TEXT fields past 2^53', () => {
    // yes 2e12 + no 5e11 + abstain 1e11 = 2.6e12 numerator.
    // denominator adds a noSide past 2^53 and an alwaysAbstain of 5e15:
    // 2.6e12 + (2^53+1) + (5e15) + 1e11(abstain already counted)... see below.
    const v = buildSpoSnapshot([
      row({
        spoYesPower: 2_000_000_000_000,
        spoNoPower: 500_000_000_000,
        spoAbstainPower: 100_000_000_000,
        spoNoSidePower: '9007199254740993', // 2^53 + 1, unrepresentable as a JS number
        spoAlwaysAbstainPower: '5000000000000000',
      }),
    ]);
    expect(v.eligible).toBe(1);
    expect(v.turnoutBasis).toBe(1);
    expect(v.turnoutExcluded).toBe(0);
    expect(v.medianTurnoutPct).toBe(0.0185);
  });

  it('excludes an eligible row with an incomplete stake tally, but still counts it as eligible', () => {
    const v = buildSpoSnapshot([row({ spoNoSidePower: null })]);
    expect(v.eligible).toBe(1);
    expect(v.turnoutBasis).toBe(0);
    expect(v.turnoutExcluded).toBe(1);
    expect(v.medianTurnoutPct).toBeNull();
  });

  it('excludes a row with an unparseable TEXT stake field', () => {
    const v = buildSpoSnapshot([row({ spoNoSidePower: 'not-a-number' })]);
    expect(v.turnoutBasis).toBe(0);
    expect(v.turnoutExcluded).toBe(1);
  });

  it('averages turnout via the median over complete actions only', () => {
    // Three complete actions with turnouts 10, 20, 30 (yes=part, total=1000).
    const withTurnout = (yes: number) =>
      row({
        spoYesPower: yes,
        spoNoPower: 0,
        spoAbstainPower: 0,
        spoNoSidePower: String(1000 - yes),
        spoAlwaysAbstainPower: '0',
      });
    const v = buildSpoSnapshot([withTurnout(100), withTurnout(200), withTurnout(300)]);
    expect(v.turnoutBasis).toBe(3);
    expect(v.medianTurnoutPct).toBe(20);
  });

  it('counts divergence only when both verdicts are known, and flags a real split', () => {
    const divergentRow = row({
      gaId: 'ga1',
      status: 'expired',
      thresholdsJson: thresholds({ drep: 67, spo: 51 }),
      drepYesPct: 80, // meets 67
      spoYesPct: 40, // misses 51
    });
    const missingDrepPct = row({
      gaId: 'ga2',
      status: 'expired',
      thresholdsJson: thresholds({ drep: 67, spo: 51 }),
      drepYesPct: null,
      spoYesPct: 90,
    });
    const v = buildSpoSnapshot([divergentRow, missingDrepPct]);
    expect(v.divergenceBasis).toBe(1);
    expect(v.divergent).toBe(1);
  });

  it('treats an enacted action as proving both verdicts, even when the stored SPO pct is below its threshold', () => {
    const v = buildSpoSnapshot([
      row({
        status: 'enacted',
        thresholdsJson: thresholds({ drep: 67, spo: 51 }),
        drepYesPct: 80, // meets 67
        spoYesPct: 40, // the stored pct misses 51, but the chain enacted the action anyway
      }),
    ]);
    expect(v.divergenceBasis).toBe(1);
    expect(v.divergent).toBe(0);
  });

  it('does not count a row as divergent-basis when it is not SPO-eligible', () => {
    const v = buildSpoSnapshot([
      row({ thresholdsJson: thresholds({ drep: 67, spo: null }), drepYesPct: 80, spoYesPct: 80 }),
    ]);
    expect(v.eligible).toBe(0);
    expect(v.divergenceBasis).toBe(0);
    expect(v.divergent).toBe(0);
  });

  it('agrees when both verdicts land the same way', () => {
    const v = buildSpoSnapshot([
      row({ thresholdsJson: thresholds({ drep: 67, spo: 51 }), drepYesPct: 80, spoYesPct: 80 }),
    ]);
    expect(v.divergenceBasis).toBe(1);
    expect(v.divergent).toBe(0);
  });
});

describe('buildThroughput', () => {
  it('returns all zeros, nulls, and an empty byType for empty input', () => {
    expect(buildThroughput([], {}, 0)).toEqual({
      submittedRecent: 0,
      windowEpochs: 12,
      enacted: 0,
      expired: 0,
      closed: 0,
      dropped: 0,
      active: 0,
      medianEpochsToDecision: null,
      decisionBasis: 0,
      byType: [],
    });
  });

  it('maps status counts, treating missing keys as 0', () => {
    const v = buildThroughput([], { enacted: 5, closed: 2 }, 7);
    expect(v.submittedRecent).toBe(7);
    expect(v.windowEpochs).toBe(12);
    expect(v.enacted).toBe(5);
    expect(v.closed).toBe(2);
    expect(v.expired).toBe(0);
    expect(v.dropped).toBe(0);
    expect(v.active).toBe(0);
  });

  it('computes the overall median with an even count by averaging the middle two', () => {
    const withSpan = (decidedEpoch: number) => row({ submittedEpoch: 600, decidedEpoch, type: 'InfoAction' });
    // Spans: 5, 7, 9, 11 -> median (7+9)/2 = 8.
    const v = buildThroughput([withSpan(605), withSpan(607), withSpan(609), withSpan(611)], {}, 0);
    expect(v.decisionBasis).toBe(4);
    expect(v.medianEpochsToDecision).toBe(8);
  });

  it('excludes rows with no known submission epoch from the median and its basis', () => {
    const v = buildThroughput(
      [row({ submittedEpoch: null, decidedEpoch: 605 }), row({ submittedEpoch: 600, decidedEpoch: 605 })],
      {},
      0,
    );
    expect(v.decisionBasis).toBe(1);
    expect(v.medianEpochsToDecision).toBe(5);
    // Both rows still count toward the type's decided total.
    expect(v.byType[0].decided).toBe(2);
  });

  it('requires at least 3 decided rows with both epochs for a per-type median, but always shows the counts', () => {
    const v = buildThroughput(
      [
        row({ gaId: 'a', type: 'A', submittedEpoch: 600, decidedEpoch: 605 }),
        row({ gaId: 'b', type: 'A', submittedEpoch: 600, decidedEpoch: 607 }),
      ],
      {},
      0,
    );
    expect(v.byType).toEqual([
      { type: 'A', decided: 2, enacted: 2, expired: 0, closed: 0, medianEpochs: null },
    ]);
  });

  it('computes a per-type median once the row floor of 3 is met', () => {
    const v = buildThroughput(
      [
        row({ gaId: 'a', type: 'A', status: 'enacted', submittedEpoch: 600, decidedEpoch: 605 }), // 5
        row({ gaId: 'b', type: 'A', status: 'expired', submittedEpoch: 600, decidedEpoch: 609 }), // 9
        row({ gaId: 'c', type: 'A', status: 'closed', submittedEpoch: 600, decidedEpoch: 611 }), // 11
      ],
      {},
      0,
    );
    expect(v.byType).toEqual([
      { type: 'A', decided: 3, enacted: 1, expired: 1, closed: 1, medianEpochs: 9 },
    ]);
  });

  it('counts a ratified row as enacted, in both the tiles and the by-type breakdown', () => {
    const v = buildThroughput([row({ status: 'ratified', type: 'A' })], { enacted: 2, ratified: 3 }, 0);
    expect(v.enacted).toBe(5);
    expect(v.byType).toEqual([{ type: 'A', decided: 1, enacted: 1, expired: 0, closed: 0, medianEpochs: null }]);
  });

  it('sorts byType by decided count descending, then type ascending on ties', () => {
    const three = (type: string, gaId: string) => row({ gaId, type, submittedEpoch: 600, decidedEpoch: 605 });
    const v = buildThroughput(
      [
        three('C', 'c1'),
        three('C', 'c2'),
        three('A', 'a1'),
        three('A', 'a2'),
        three('A', 'a3'),
        three('B', 'b1'),
        three('B', 'b2'),
        three('B', 'b3'),
      ],
      {},
      0,
    );
    expect(v.byType.map((t) => t.type)).toEqual(['A', 'B', 'C']);
  });
});

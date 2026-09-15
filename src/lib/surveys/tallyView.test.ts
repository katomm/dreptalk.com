// Import only what is used: Biome's lint gate fails on an unused import, and
// this file needs no Role and no SurveyDefinition.
import { describe, expect, it } from 'vitest';
import type { Question } from 'cip-179';
import { hexToBytes } from 'cip-179/domain';
import type { ArtifactQuestion } from 'cip-179/tally';
import { fracOf, MAX_DISPLAY_BUCKETS, questionView, ratioOf } from './tallyView.js';

const SINGLE: Question = {
  type: 'singleChoice',
  prompt: 'Pick',
  options: { type: 'options', labels: ['A', 'B', 'C'] },
  required: true,
};

describe('fracOf and ratioOf', () => {
  it('returns 0 for an empty maximum rather than dividing by zero', () => {
    expect(fracOf(5n, 0n)).toBe(0);
  });

  it('returns null for an empty denominator so a caller cannot render 0%', () => {
    expect(ratioOf(5n, 0n)).toBeNull();
  });

  it('keeps four decimal places without touching Number on the inputs', () => {
    // Both operands exceed 2^53, so a float implementation would drift here.
    expect(fracOf(10_000_000_000_000_000n, 30_000_000_000_000_000n)).toBeCloseTo(0.3333, 4);
  });

  it('is exactly 1 when part equals max, even far past 2^53', () => {
    expect(fracOf(45_000_000_000_000_000n, 45_000_000_000_000_000n)).toBe(1);
  });
});

describe('questionView, options kind', () => {
  const aq: ArtifactQuestion = {
    kind: 'options',
    unit: 'singleChoice',
    options: [
      { index: 0, weight: '3000000', count: 2 },
      { index: 2, weight: '1000000', count: 1 },
    ],
    answeredCount: 3,
    answeredWeight: '4000000',
  };

  it('refills zero-answer options from the definition so every choice shows', () => {
    const v = questionView(SINGLE, aq);
    expect(v.kind).toBe('bars');
    if (v.kind !== 'bars') throw new Error('kind');
    expect(v.bars.map(b => b.label)).toEqual(['A', 'B', 'C']);
    expect(v.bars[1]!.count).toBe(0);
    expect(v.bars[1]!.weight).toBe(0n);
  });

  it('fills a single-choice bar as a share of the answered weight, not of the leader', () => {
    // The deliberate divergence from upstream: 3 of 4 million is 0.75, where a
    // leader-relative fill would make the leading bar 1.0.
    const v = questionView(SINGLE, aq);
    if (v.kind !== 'bars') throw new Error('kind');
    expect(v.bars[0]!.frac).toBeCloseTo(0.75, 4);
    expect(v.bars[2]!.frac).toBeCloseTo(0.25, 4);
  });

  it('fills a multi-select bar relative to the leading bar', () => {
    const multi: Question = {
      type: 'multiSelect',
      prompt: 'Choose',
      options: { type: 'options', labels: ['A', 'B'] },
      minSelections: 1,
      maxSelections: 2,
    };
    const v = questionView(multi, {
      ...aq,
      unit: 'multiSelect',
      options: [
        { index: 0, weight: '3000000', count: 2 },
        { index: 1, weight: '1000000', count: 1 },
      ],
    });
    if (v.kind !== 'bars') throw new Error('kind');
    expect(v.bars[0]!.frac).toBe(1);
    expect(v.bars[1]!.frac).toBeCloseTo(0.3333, 4);
  });

  it('fills a ranking bar relative to the leading bar, never as a share of the answered weight', () => {
    // The committed tally carries first preferences only, so a share would
    // claim the full ranking. 3 of 4 million would read as 0.75 on a share
    // basis, where the leader basis puts the leading bar at 1.0 and the runner
    // up at a third of it. A regression that extended the single-choice share
    // divergence to rankingFirst fails both assertions below.
    const ranking: Question = {
      type: 'ranking',
      prompt: 'Order these',
      options: { type: 'options', labels: ['A', 'B', 'C'] },
      minRanked: 1,
      maxRanked: 3,
    };
    const v = questionView(ranking, {
      kind: 'options',
      unit: 'rankingFirst',
      options: [
        { index: 0, weight: '3000000', count: 2 },
        { index: 1, weight: '1000000', count: 1 },
      ],
      answeredCount: 3,
      answeredWeight: '4000000',
    });
    expect(v.kind).toBe('bars');
    if (v.kind !== 'bars') throw new Error('kind');
    expect(v.unit).toBe('rankingFirst');
    expect(v.bars[0]!.frac).toBe(1);
    expect(v.bars[1]!.frac).toBeCloseTo(0.3333, 4);
    // The unranked third option still shows, empty.
    expect(v.bars.map(b => b.label)).toEqual(['A', 'B', 'C']);
    expect(v.bars[2]!.count).toBe(0);
    expect(v.bars[2]!.frac).toBe(0);
  });

  it('caps the refill of a hostile declared option count but keeps a high answered index', () => {
    const hostile: Question = {
      type: 'singleChoice',
      prompt: 'Pick',
      options: { type: 'count', count: 1_000_000 },
      required: true,
    };
    const v = questionView(hostile, {
      kind: 'options',
      unit: 'singleChoice',
      options: [{ index: 999_999, weight: '1000000', count: 1 }],
      answeredCount: 1,
      answeredWeight: '1000000',
    });
    if (v.kind !== 'bars') throw new Error('kind');
    expect(v.bars.length).toBe(MAX_DISPLAY_BUCKETS + 1);
    expect(v.bars.at(-1)!.count).toBe(1);
  });
});

describe('questionView, numeric kind', () => {
  it('reports the weighted mean and the weighted median', () => {
    const v = questionView(
      { type: 'numericRange', prompt: 'How much', constraints: { min: 0n, max: 10n } },
      {
        kind: 'numeric',
        weightedSum: '30',
        answeredWeight: '3',
        answeredCount: 3,
        values: [
          { value: '5', weight: '1', count: 1 },
          { value: '10', weight: '1', count: 1 },
          { value: '15', weight: '1', count: 1 },
        ],
      },
    );
    if (v.kind !== 'histogram') throw new Error('kind');
    expect(v.mean).toBeCloseTo(10, 4);
    expect(v.median).toBe(10);
  });

  it('averages the two neighbours when the halfway point falls on a bin boundary', () => {
    const v = questionView(
      { type: 'numericRange', prompt: 'How much', constraints: { min: 0n, max: 10n } },
      {
        kind: 'numeric',
        weightedSum: '6',
        answeredWeight: '2',
        answeredCount: 2,
        values: [
          { value: '2', weight: '1', count: 1 },
          { value: '4', weight: '1', count: 1 },
        ],
      },
    );
    if (v.kind !== 'histogram') throw new Error('kind');
    expect(v.median).toBe(3);
  });

  it('steps over a zero-weight bin when the halfway point falls on a boundary', () => {
    // A registered DRep with no voting power is counted at 0n and keeps its bin,
    // so a value can carry a count while carrying no weight. The median divides
    // weight, so such a bin holds no half of anything: averaging with it would
    // put the median on a value no weighed responder chose. Here the weighed
    // answers are 0 and 10, whose median is 5, not the 1 that averaging with the
    // zero-weight bin at 2 would give.
    const v = questionView(
      { type: 'numericRange', prompt: 'How much', constraints: { min: 0n, max: 10n } },
      {
        kind: 'numeric',
        weightedSum: '10',
        answeredWeight: '2',
        answeredCount: 3,
        values: [
          { value: '0', weight: '1', count: 1 },
          { value: '2', weight: '0', count: 1 },
          { value: '10', weight: '1', count: 1 },
        ],
      },
    );
    if (v.kind !== 'histogram') throw new Error('kind');
    expect(v.median).toBe(5);
  });

  it('keeps the last weighed value when only zero-weight bins follow', () => {
    const v = questionView(
      { type: 'numericRange', prompt: 'How much', constraints: { min: 0n, max: 10n } },
      {
        kind: 'numeric',
        weightedSum: '4',
        answeredWeight: '2',
        answeredCount: 3,
        values: [
          { value: '0', weight: '1', count: 1 },
          { value: '4', weight: '1', count: 1 },
          { value: '9', weight: '0', count: 1 },
        ],
      },
    );
    if (v.kind !== 'histogram') throw new Error('kind');
    expect(v.median).toBe(2);
  });

  it('reports a null mean and median with no answers rather than zero', () => {
    const v = questionView(
      { type: 'numericRange', prompt: 'How much', constraints: { min: 0n, max: 10n } },
      { kind: 'numeric', weightedSum: '0', answeredWeight: '0', answeredCount: 0, values: [] },
    );
    if (v.kind !== 'histogram') throw new Error('kind');
    expect(v.mean).toBeNull();
    expect(v.median).toBeNull();
  });

  it('labels bins by their value and fills them relative to the leading bin', () => {
    // Histogram bins are unaffected by the single-choice divergence: they stay
    // leader-relative, same as upstream.
    const v = questionView(undefined, {
      kind: 'numeric',
      weightedSum: '1310',
      answeredWeight: '110',
      answeredCount: 3,
      values: [
        { value: '10', weight: '103', count: 2 },
        { value: '40', weight: '7', count: 1 },
      ],
    });
    if (v.kind !== 'histogram') throw new Error('kind');
    expect(v.mean).toBe(11.909);
    expect(v.bins.map(b => b.label)).toEqual(['10', '40']);
    expect(v.bins[0]!.frac).toBe(1);
  });
});

describe('questionView, perOption kind', () => {
  it('divides a rating option by its own committed denominator', () => {
    const q: Question = {
      type: 'rating',
      prompt: 'Rate',
      options: { type: 'options', labels: ['X', 'Y'] },
      scale: { type: 'numeric', constraints: { min: 1n, max: 5n } },
      requireAll: false,
    };
    const v = questionView(q, {
      kind: 'perOption',
      unit: 'rating',
      perOption: [
        { index: 0, weightedSum: '8', answeredWeight: '2', count: 2 },
        { index: 1, weightedSum: '3', answeredWeight: '1', count: 1 },
      ],
      answeredCount: 2,
      answeredWeight: '2',
    });
    if (v.kind !== 'rows') throw new Error('kind');
    expect(v.rows[0]!.avg).toBeCloseTo(4, 4);
    expect(v.rows[1]!.avg).toBeCloseTo(3, 4);
  });

  it('refills an unrated option as a null average rather than zero', () => {
    const q: Question = {
      type: 'rating',
      prompt: 'Rate',
      options: { type: 'options', labels: ['X', 'Y'] },
      scale: { type: 'numeric', constraints: { min: 1n, max: 5n } },
      requireAll: false,
    };
    const v = questionView(q, {
      kind: 'perOption',
      unit: 'rating',
      // Only "X" was rated, "no" (Y) is absent and refilled as an empty row.
      perOption: [{ index: 0, weightedSum: '507', answeredWeight: '107', count: 2 }],
      answeredCount: 2,
      answeredWeight: '107',
    });
    if (v.kind !== 'rows') throw new Error('kind');
    expect(v.rows[0]).toEqual({ label: 'X', avg: 4.7383, count: 2 });
    expect(v.rows[1]).toEqual({ label: 'Y', avg: null, count: 0 });
  });

  it('falls back to the question-level denominator for points, which omits its own', () => {
    const q: Question = {
      type: 'pointsAllocation',
      prompt: 'Spend',
      options: { type: 'options', labels: ['X', 'Y'] },
      budget: 10n,
    };
    const v = questionView(q, {
      kind: 'perOption',
      unit: 'points',
      perOption: [{ index: 0, weightedSum: '14', count: 2 }],
      answeredCount: 2,
      answeredWeight: '2',
    });
    if (v.kind !== 'rows') throw new Error('kind');
    expect(v.rows[0]!.avg).toBeCloseTo(7, 4);
    expect(v.rows[1]!.avg).toBeNull();
  });
});

describe('questionView, custom kind', () => {
  it('carries participation only and never a bar', () => {
    const v = questionView(
      // cip-179's CustomQuestion carries a methodSchema anchor, not a length.
      { type: 'custom', prompt: 'Why', methodSchema: { uri: 'ipfs://x', hash: hexToBytes('00'.repeat(32)) } },
      { kind: 'custom', answeredCount: 4, answeredWeight: '9' },
    );
    expect(v.kind).toBe('custom');
    if (v.kind !== 'custom') throw new Error('kind');
    expect(v.answeredCount).toBe(4);
    expect(v.answeredWeight).toBe(9n);
  });
});

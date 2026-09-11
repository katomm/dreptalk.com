// The join between the two stored tally runs, which is the subtlest arithmetic
// in the survey card and the reason the two-run design exists. Biome does not
// lint .astro and astro check only typechecks it, so these tests are the only
// automated gate on the behaviour below.
import { describe, expect, it } from 'vitest';
import type { Question } from 'cip-179';
import type { ArtifactQuestion } from 'cip-179/tally';
import { abstentions, alignIndices, joinNumericBins } from './tallyJoin.js';
import { questionView } from './tallyView.js';

/** Two declared options, so a populated index 5 is beyond the declared width. */
const SINGLE: Question = {
  type: 'singleChoice',
  prompt: 'Pick',
  options: { type: 'options', labels: ['A', 'B'] },
  required: true,
};

const MULTI: Question = {
  type: 'multiSelect',
  prompt: 'Choose',
  options: { type: 'options', labels: ['A', 'B'] },
  minSelections: 1,
  maxSelections: 2,
};

function options(
  unit: 'singleChoice' | 'multiSelect',
  entries: { index: number; weight: string; count: number }[],
  answeredCount: number,
  answeredWeight: string,
): ArtifactQuestion {
  return { kind: 'options', unit, options: entries, answeredCount, answeredWeight };
}

describe('alignIndices, option questions', () => {
  // (a) The two runs answered no option in common, which is the shape a naive
  // positional read pairs wrongly.
  it('gives two runs with disjoint populated indices one index list and one label list', () => {
    const w = options('singleChoice', [{ index: 0, weight: '5000000', count: 1 }], 1, '5000000');
    const h = options('singleChoice', [{ index: 5, weight: '1', count: 1 }], 1, '1');

    const rawW = questionView(SINGLE, w);
    const rawH = questionView(SINGLE, h);
    if (rawW.kind !== 'bars' || rawH.kind !== 'bars') throw new Error('kind');
    // Unaligned the two lists are different lengths, so position 2 of one run is
    // not position 2 of the other.
    expect(rawW.bars.length).toBe(2);
    expect(rawH.bars.length).toBe(3);

    const [aw, ah] = alignIndices(w, h);
    const vw = questionView(SINGLE, aw);
    const vh = questionView(SINGLE, ah);
    if (vw.kind !== 'bars' || vh.kind !== 'bars') throw new Error('kind');
    expect(vw.bars.map(b => b.label)).toEqual(['A', 'B', 'Option 6']);
    expect(vh.bars.map(b => b.label)).toEqual(['A', 'B', 'Option 6']);
    // Position 2 now carries the head count of the index only the head-count run
    // saw, against a weighted bar that genuinely holds nothing.
    expect(vh.bars[2]!.count).toBe(1);
    expect(vw.bars[2]!.weight).toBe(0n);
    expect(vw.bars[2]!.count).toBe(0);
  });

  // (b) The injection must be invisible to every figure, or the join would be
  // buying its alignment with a changed reading.
  it('leaves the single-choice denominator, the answered figures and the fractions untouched', () => {
    const w = options(
      'singleChoice',
      [
        { index: 0, weight: '3000000', count: 2 },
        { index: 1, weight: '1000000', count: 1 },
      ],
      3,
      '4000000',
    );
    const h = options('singleChoice', [{ index: 5, weight: '1', count: 1 }], 1, '1');

    const raw = questionView(SINGLE, w);
    const [aw] = alignIndices(w, h);
    const aligned = questionView(SINGLE, aw);
    if (raw.kind !== 'bars' || aligned.kind !== 'bars') throw new Error('kind');

    expect(aligned.answeredCount).toBe(raw.answeredCount);
    expect(aligned.answeredWeight).toBe(raw.answeredWeight);
    // The denominator of a single-choice share is the question's answered
    // weight, so the shares of the real options must be identical.
    expect(aligned.bars.slice(0, 2)).toEqual(raw.bars);
    expect(aligned.bars[0]!.frac).toBeCloseTo(0.75, 4);
  });

  it('leaves the leader-relative fractions of a multi-select untouched', () => {
    const w = options(
      'multiSelect',
      [
        { index: 0, weight: '3000000', count: 2 },
        { index: 1, weight: '1000000', count: 1 },
      ],
      2,
      '4000000',
    );
    const h = options('multiSelect', [{ index: 5, weight: '1', count: 1 }], 1, '1');

    const raw = questionView(MULTI, w);
    const [aw] = alignIndices(w, h);
    const aligned = questionView(MULTI, aw);
    if (raw.kind !== 'bars' || aligned.kind !== 'bars') throw new Error('kind');

    // A zero weight cannot be the maximum, so the leader is the same bar.
    expect(aligned.bars.slice(0, 2)).toEqual(raw.bars);
    expect(aligned.bars[0]!.frac).toBe(1);
    expect(aligned.bars[2]!.frac).toBe(0);
  });

  it('leaves a run alone when the other adds no index', () => {
    const w = options('singleChoice', [{ index: 0, weight: '5', count: 1 }], 1, '5');
    const h = options('singleChoice', [{ index: 0, weight: '1', count: 1 }], 1, '1');
    const [aw, ah] = alignIndices(w, h);
    expect(aw).toBe(w);
    expect(ah).toBe(h);
  });
});

describe('abstentions', () => {
  // (c) The headline case the whole two-run design exists for.
  it('reports no abstention for a counted DRep that could not be weighted', () => {
    const counted = 2;
    // Both counted DReps answered. The head-count run carries both at unit
    // weight, the weighted run carries only the one with a power row.
    const headcount = options(
      'singleChoice',
      [{ index: 0, weight: '2', count: 2 }],
      2,
      '2',
    );
    const weighted = options(
      'singleChoice',
      [{ index: 0, weight: '5000000', count: 1 }],
      1,
      '5000000',
    );
    const hview = questionView(SINGLE, headcount);
    const wview = questionView(SINGLE, weighted);

    expect(abstentions(counted, hview.answeredCount)).toBe(0);
    // Reading the weighted run instead invents an abstention nobody made, which
    // is the regression this function exists to keep out.
    expect(abstentions(counted, wview.answeredCount)).toBe(1);
  });

  it('never goes negative when the head count comes from a wider set', () => {
    expect(abstentions(2, 5)).toBe(0);
  });
});

describe('joinNumericBins', () => {
  // (d) Why numeric is joined on the value and never by injection: the weighted
  // median walks the bins accumulating weight, so a zero-weight bin at the
  // halfway point moves it.
  it('renders a value only the head-count run saw without moving the median', () => {
    const weighted: ArtifactQuestion = {
      kind: 'numeric',
      weightedSum: '150',
      answeredWeight: '10',
      answeredCount: 2,
      values: [
        { value: '10', weight: '5', count: 1 },
        { value: '20', weight: '5', count: 1 },
      ],
    };
    const headcount: ArtifactQuestion = {
      kind: 'numeric',
      weightedSum: '45',
      answeredWeight: '3',
      answeredCount: 3,
      values: [
        { value: '10', weight: '1', count: 1 },
        { value: '15', weight: '1', count: 1 },
        { value: '20', weight: '1', count: 1 },
      ],
    };
    const wview = questionView(undefined, weighted);
    const hview = questionView(undefined, headcount);
    if (wview.kind !== 'histogram' || hview.kind !== 'histogram') throw new Error('kind');

    // The halfway point is exactly on the boundary between 10 and 20.
    expect(wview.median).toBe(15);

    const joined = joinNumericBins(wview.bins, hview.bins, true);
    expect(joined.map(b => b.value)).toEqual(['10', '15', '20']);
    const injected = joined[1]!;
    expect(injected.count).toBe(1);
    expect(injected.weight).toBe(0n);
    expect(injected.frac).toBe(0);
    // The weighted run is untouched, so its median is still the real one. This
    // is what injecting a zero-weight 15 bin instead would have done to it, and
    // the reason numeric is joined on the value.
    const injectedRun = questionView(undefined, {
      ...weighted,
      values: [
        { value: '10', weight: '5', count: 1 },
        { value: '15', weight: '0', count: 0 },
        { value: '20', weight: '5', count: 1 },
      ],
    });
    if (injectedRun.kind !== 'histogram') throw new Error('kind');
    expect(injectedRun.median).toBe(12.5);
    expect(wview.median).toBe(15);
  });

  it('sorts the merged values numerically, not as strings', () => {
    const shown: ArtifactQuestion = {
      kind: 'numeric',
      weightedSum: '0',
      answeredWeight: '3',
      answeredCount: 3,
      values: [
        { value: '2', weight: '1', count: 1 },
        { value: '10', weight: '1', count: 1 },
        { value: '100', weight: '1', count: 1 },
      ],
    };
    const view = questionView(undefined, shown);
    if (view.kind !== 'histogram') throw new Error('kind');
    expect(joinNumericBins(view.bins, null, true).map(b => b.value)).toEqual(['2', '10', '100']);
  });

  it('claims no head count for a weighted run with no head-count run beside it', () => {
    const shown: ArtifactQuestion = {
      kind: 'numeric',
      weightedSum: '10',
      answeredWeight: '1',
      answeredCount: 1,
      values: [{ value: '10', weight: '1', count: 1 }],
    };
    const view = questionView(undefined, shown);
    if (view.kind !== 'histogram') throw new Error('kind');
    expect(joinNumericBins(view.bins, null, true)[0]!.count).toBeNull();
    // On the head-count run itself the bin's own count is the head count.
    expect(joinNumericBins(view.bins, null, false)[0]!.count).toBe(1);
  });
});

describe('alignIndices, rating questions', () => {
  // (e) An injected rating option has no raters, and a mean over no raters is
  // undefined, never zero.
  it('injects a rating option as an unrated row rather than a zero mean', () => {
    const rating: Question = {
      type: 'rating',
      prompt: 'Rate',
      options: { type: 'options', labels: ['X', 'Y'] },
      scale: { type: 'numeric', constraints: { min: 1n, max: 5n } },
      requireAll: false,
    };
    const w: ArtifactQuestion = {
      kind: 'perOption',
      unit: 'rating',
      perOption: [{ index: 0, weightedSum: '8000000', answeredWeight: '2000000', count: 1 }],
      answeredCount: 1,
      answeredWeight: '2000000',
    };
    const h: ArtifactQuestion = {
      kind: 'perOption',
      unit: 'rating',
      perOption: [
        { index: 0, weightedSum: '4', answeredWeight: '1', count: 1 },
        { index: 5, weightedSum: '3', answeredWeight: '1', count: 1 },
      ],
      answeredCount: 2,
      answeredWeight: '2',
    };

    const [aw, ah] = alignIndices(w, h);
    const vw = questionView(rating, aw);
    const vh = questionView(rating, ah);
    if (vw.kind !== 'rows' || vh.kind !== 'rows') throw new Error('kind');

    expect(vw.rows.map(r => r.label)).toEqual(vh.rows.map(r => r.label));
    const injected = vw.rows[2]!;
    expect(injected.avg).toBeNull();
    expect(injected.count).toBe(0);
    // The real option keeps its own mean, unchanged by the injection.
    expect(vw.rows[0]!.avg).toBeCloseTo(4, 4);
    expect(vh.rows[2]!.avg).toBeCloseTo(3, 4);
  });
});

// Render-ready projection of a cip-179 ArtifactQuestion. The only file in this
// codebase that produces floats, always from exact integers and never stored.
//
// Ported from Tessera, frontend/app/src/domain/results.ts
// (https://github.com/mpizenberg/Tessera), Apache License 2.0. See
// THIRD-PARTY-NOTICES.md. Kept close to the original on purpose: a divergence
// here is a porting bug unless it is the one listed below.
//
// DELIBERATE DIVERGENCE: a single-choice bar is filled as a share of the
// question's answered weight, where upstream fills every bar relative to the
// leading one and shows no percentage anywhere. Single choice is the only kind
// whose shares sum to one whole, so it is the only kind where a percentage
// cannot be misread. The basis per kind is declared in
// ./surveyTallyContract.ts, which is the contract for this behaviour. Do not
// "restore" the upstream behaviour without reading the design doc.

import type { Question, RatingScale } from 'cip-179';
import { optionLabelOf } from 'cip-179/domain';
import type { ArtifactQuestion } from 'cip-179/tally';

// ---------------------------------------------------------------------------
// Exact integers to display floats
// ---------------------------------------------------------------------------

/** Fill fraction 0 to 1 of `part` relative to `max` (4 decimal places). */
export function fracOf(part: bigint, max: bigint): number {
  if (max <= 0n) return 0;
  return Number((part * 10_000n) / max) / 10_000;
}

/** `num / den` to 4 decimal places, or null when the denominator is empty. */
export function ratioOf(num: bigint, den: bigint): number | null {
  if (den <= 0n) return null;
  return Number((num * 10_000n) / den) / 10_000;
}

/**
 * Upper bound on how many option/level buckets any widget will materialize. A
 * hostile definition can declare an astronomically large option `count` or
 * rating span. the committed tally is sparse (it grows with responses, never
 * with the declared span), but the display refills zero-answer buckets so the
 * reader sees every choice. Without this cap that refill is an
 * attacker-controlled allocation. No real survey approaches it. a pathological
 * one renders its first buckets plus whatever higher indices were answered.
 */
export const MAX_DISPLAY_BUCKETS = 1000;

// ---------------------------------------------------------------------------
// Committed: the artifact's aggregates, made render-ready
// ---------------------------------------------------------------------------

export interface BarView {
  readonly label: string;
  readonly weight: bigint;
  readonly count: number;
  /** Fill fraction 0 to 1. Basis depends on the question kind, see the header note. */
  readonly frac: number;
}

export interface RowView {
  readonly label: string;
  /** Weighted mean, or null when nothing backs it. */
  readonly avg: number | null;
  readonly count: number;
}

export type QuestionView =
  | {
      readonly kind: 'bars';
      readonly unit: 'singleChoice' | 'multiSelect' | 'rankingFirst';
      readonly bars: readonly BarView[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: 'histogram';
      readonly bins: readonly BarView[];
      /** Weighted mean of the numeric values, or null with no answers. */
      readonly mean: number | null;
      /** Weighted median, the value where half the weight has accumulated. */
      readonly median: number | null;
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: 'rows';
      readonly unit: 'points' | 'rating';
      readonly rows: readonly RowView[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: 'custom';
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    };

function barViews(
  labels: readonly string[],
  weights: readonly bigint[],
  counts: readonly number[],
): BarView[] {
  const max = weights.reduce((a, b) => (b > a ? b : a), 0n);
  return labels.map((label, i) => ({
    label,
    weight: weights[i] ?? 0n,
    count: counts[i] ?? 0,
    frac: fracOf(weights[i] ?? 0n, max),
  }));
}

/** Declared option count of a question, or null when it has no options. */
function declaredOptionCount(q: Question | undefined): number | null {
  if (q && 'options' in q) return q.options.type === 'options' ? q.options.labels.length : q.options.count;
  return null;
}

/**
 * Which option indices to render for a *sparse* committed question. The tally
 * carries only answered options. here we fill 0..min(declared, cap) so
 * zero-answer options still show as empty rows, then append any populated index
 * beyond that (a hostile huge-count survey answered at a high index) so nothing
 * counted is hidden, all without ever materializing the attacker-declared
 * width (see {@link MAX_DISPLAY_BUCKETS}).
 */
function renderIndices(q: Question | undefined, populated: readonly number[]): number[] {
  const declared = declaredOptionCount(q);
  const set = new Set<number>();
  if (declared !== null) {
    const n = Math.min(declared, MAX_DISPLAY_BUCKETS);
    for (let i = 0; i < n; i++) set.add(i);
  }
  for (const i of populated) set.add(i);
  return [...set].sort((a, b) => a - b);
}

/**
 * The value at which half the answered weight has accumulated. Bins arrive
 * value-ascending. when the halfway point falls exactly on a bin boundary the
 * two neighbours are averaged, so at unit weights this is the ordinary median.
 */
function weightedMedian(
  bins: readonly { value: string; weight: string }[],
  answeredWeight: bigint,
): number | null {
  if (answeredWeight <= 0n) return null;
  let cumulative = 0n;
  for (let i = 0; i < bins.length; i++) {
    cumulative += BigInt(bins[i]!.weight);
    const doubled = cumulative * 2n;
    if (doubled > answeredWeight) return Number(bins[i]!.value);
    if (doubled === answeredWeight) {
      const next = bins[i + 1];
      const here = Number(bins[i]!.value);
      return next ? (here + Number(next.value)) / 2 : here;
    }
  }
  return null;
}

/** One committed question tally, made render-ready against the definition. */
export function questionView(q: Question | undefined, aq: ArtifactQuestion): QuestionView {
  switch (aq.kind) {
    case 'options': {
      const byIndex = new Map(aq.options.map(o => [o.index, o]));
      const leader = aq.options.reduce((m, o) => {
        const w = BigInt(o.weight);
        return w > m ? w : m;
      }, 0n);
      // See the DELIBERATE DIVERGENCE note in this file's header.
      const denom = aq.unit === 'singleChoice' ? BigInt(aq.answeredWeight) : leader;
      const bars = renderIndices(
        q,
        aq.options.map(o => o.index),
      ).map(index => {
        const o = byIndex.get(index);
        const weight = o ? BigInt(o.weight) : 0n;
        return {
          label: optionLabelOf(q, index),
          weight,
          count: o?.count ?? 0,
          frac: fracOf(weight, denom),
        };
      });
      return {
        kind: 'bars',
        unit: aq.unit,
        bars,
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
    }
    case 'numeric': {
      const answeredWeight = BigInt(aq.answeredWeight);
      return {
        kind: 'histogram',
        bins: barViews(
          aq.values.map(v => v.value),
          aq.values.map(v => BigInt(v.weight)),
          aq.values.map(v => v.count),
        ),
        mean: ratioOf(BigInt(aq.weightedSum), answeredWeight),
        median: weightedMedian(aq.values, answeredWeight),
        answeredCount: aq.answeredCount,
        answeredWeight,
      };
    }
    case 'perOption': {
      const byIndex = new Map(aq.perOption.map(o => [o.index, o]));
      const rows = renderIndices(
        q,
        aq.perOption.map(o => o.index),
      ).map(index => {
        const o = byIndex.get(index);
        // Points omits the per-option denominator (it equals the question-level
        // `answeredWeight`, identical for every option). rating commits its own.
        const denom = o?.answeredWeight ?? aq.answeredWeight;
        return {
          label: optionLabelOf(q, index),
          avg: o ? ratioOf(BigInt(o.weightedSum), BigInt(denom)) : null,
          count: o?.count ?? 0,
        };
      });
      return {
        kind: 'rows',
        unit: aq.unit,
        rows,
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
    }
    case 'custom':
      return {
        kind: 'custom',
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
  }
}

/** Level layout of a rating scale: how many, labelled how, spaced how. */
export function ratingScaleInfo(scale: RatingScale): {
  levels: number;
  levelLabels: string[] | null;
  numeric: boolean;
  baseMin: number;
  /** Value increment between adjacent levels (1 for label/count scales). */
  step: number;
} {
  switch (scale.type) {
    case 'numeric': {
      const min = Number(scale.constraints.min);
      const max = Number(scale.constraints.max);
      // A stepped scale (e.g. 0..10 by 2) has fewer distinct levels than its
      // span. bucket on step units so the histogram has no empty gaps.
      const step =
        scale.constraints.step !== undefined && scale.constraints.step > 0n
          ? Number(scale.constraints.step)
          : 1;
      return {
        levels: Math.max(1, Math.floor((max - min) / step) + 1),
        levelLabels: null,
        numeric: true,
        baseMin: min,
        step,
      };
    }
    case 'labels':
      return {
        levels: scale.labels.length,
        levelLabels: [...scale.labels],
        numeric: false,
        baseMin: 0,
        step: 1,
      };
    case 'count':
      return {
        levels: scale.count,
        levelLabels: null,
        numeric: false,
        baseMin: 0,
        step: 1,
      };
  }
}

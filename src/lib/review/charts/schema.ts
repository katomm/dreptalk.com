import { z } from 'zod';

// Every chart names the pack fields its series come from (one path per series,
// see the fact check). The unit contract is the `format`: 'M' means the shown
// numbers are the source divided by a million, 'B' by a billion, '%' and 'int'
// are the source as stored. scaleFor(format) is the single place that mapping
// lives, shared by the renderer's labels and the fact check.
export const formatSchema = z.enum(['M', 'B', '%', 'int']).default('int');
export function scaleFor(format: 'M' | 'B' | '%' | 'int'): number {
  return format === 'M' ? 1e6 : format === 'B' ? 1e9 : 1;
}
const base = {
  title: z.string().min(1),
  subtitle: z.string().optional(),
  caption: z.string().optional(),
  sources: z.array(z.string().min(1)).min(1),
  format: formatSchema,
};
const nonEmptyNumbers = z.array(z.number()).min(1);
const numbersWithGaps = z.array(z.number().nullable()).min(2);

export const lineSpec = z.object({
  ...base,
  type: z.literal('line'),
  epochFrom: z.number().int(),
  /** Pack path to the epochs of the source series, checked against epochFrom + index. */
  epochSource: z.string().min(1),
  values: numbersWithGaps,
  yMin: z.number(),
  yMax: z.number(),
  markers: z.array(z.object({ epoch: z.number().int(), label: z.string() })).default([]),
  shade: z.tuple([z.number().int(), z.number().int()]).optional(),
  area: z.boolean().default(false),
}).refine((s) => s.yMax > s.yMin, { message: 'yMax must exceed yMin' });

export const linesSpec = z.object({
  ...base,
  type: z.literal('lines'),
  xLabel: z.string(),
  series: z.array(z.object({ name: z.string().min(1), values: nonEmptyNumbers })).min(2).max(2),
});

export const stackedSpec = z.object({
  ...base,
  type: z.literal('stacked'),
  epochSource: z.string().min(1),
  epochs: z.array(z.number().int()).min(1),
  yes: nonEmptyNumbers,
  no: nonEmptyNumbers,
  abstain: nonEmptyNumbers,
}).refine((s) => s.yes.length === s.epochs.length && s.no.length === s.epochs.length && s.abstain.length === s.epochs.length, { message: 'series lengths must match epochs' });

export const barsSpec = z.object({
  ...base,
  type: z.literal('bars'),
  epochSource: z.string().min(1),
  epochs: z.array(z.number().int()).min(1),
  values: nonEmptyNumbers,
  highlight: z.tuple([z.number().int(), z.number().int()]).optional(),
}).refine((s) => s.values.length === s.epochs.length, { message: 'values must match epochs' });

export const hbarsSpec = z.object({
  ...base,
  type: z.literal('hbars'),
  threshold: z.number().optional(),
  max: z.number().optional(),
  rows: z.array(z.object({ label: z.string().min(1), value: z.number(), tone: z.enum(['yes', 'no', 'abstain']).default('yes') })).min(1),
});

export const seatsSpec = z.object({
  ...base,
  type: z.literal('seats'),
  groups: z.array(z.object({ label: z.string().min(1), count: z.number().int().min(0), tone: z.enum(['ending', 'staying']) })).min(1),
});

// One point per withdrawal: how much it asked for against the share that
// answered. Two axes in different units, so `format` covers the share and
// `xFormat` the amount, and `sources` names two paths per point, the amount
// first and the share second. `tone` is the status AT THE EDITION'S CUTOFF:
// an action ratified but not yet paid is not the same as a paid one.
export const scatterSpec = z.object({
  ...base,
  type: z.literal('scatter'),
  xLabel: z.string().min(1),
  xFormat: formatSchema,
  threshold: z.number().optional(),
  points: z.array(z.object({
    label: z.string().min(1),
    x: z.number(),
    y: z.number(),
    tone: z.enum(['yes', 'no', 'abstain']).default('yes'),
  })).min(2),
});

// Voting power per proposal, in ada rather than ballots: what actually voted
// yes, what voted no, and what abstained, on one scale across the rows. The
// reported share cannot be read off the bar, because abstaining power is
// excluded from it, so every row carries that share as its own figure.
// `sources` names four paths per row: yes, no, abstain, share.
export const powerSpec = z.object({
  ...base,
  type: z.literal('power'),
  rows: z.array(z.object({
    label: z.string().min(1),
    yes: z.number().min(0),
    no: z.number().min(0),
    abstain: z.number().min(0),
    share: z.number(),
  })).min(1),
  threshold: z.number().optional(),
});

// Ballots of a few named voters on a few actions: rows are actions, columns
// voters, each cell the pack's own ballot string. Equal cells show decisions,
// not weights. `sources` names one pack path per cell in row order, such as
// topDreps[0].ballots.<action id>, and the fact check compares the strings.
export const matrixSpec = z.object({
  ...base,
  type: z.literal('matrix'),
  columns: z.array(z.string().min(1)).min(1).max(8),
  rows: z.array(z.object({
    label: z.string().min(1),
    cells: z.array(z.enum(['Yes', 'No', 'Abstain', 'did not vote'])).min(1),
  })).min(1),
}).refine((s) => s.rows.every((r) => r.cells.length === s.columns.length), { message: 'every row needs one cell per column' });

// A request that came back: per panel one measure before and after, each
// panel in its own unit, so `sources` names two paths per panel, before then
// after. A threshold on a share panel draws the bar it had to reach.
export const beforeAfterSpec = z.object({
  ...base,
  type: z.literal('beforeAfter'),
  panels: z.array(z.object({
    label: z.string().min(1),
    format: formatSchema,
    before: z.object({ label: z.string().min(1), value: z.number() }),
    after: z.object({ label: z.string().min(1), value: z.number() }),
    threshold: z.number().optional(),
  })).min(1).max(3),
});

// Dated events on one epoch axis. `sources` names one pack path per item,
// the epoch it is drawn at.
export const timelineSpec = z.object({
  ...base,
  type: z.literal('timeline'),
  items: z.array(z.object({
    epoch: z.number().int(),
    label: z.string().min(1),
    tone: z.enum(['yes', 'no', 'abstain']).default('yes'),
  })).min(2).max(8),
});

// A spending limit as one bar: the segments add up to the total, a marker draws
// an earlier ceiling. `sources` names one path per segment, then the total,
// then the marker when there is one.
export const budgetSpec = z.object({
  ...base,
  type: z.literal('budget'),
  segments: z.array(z.object({ label: z.string().min(1), value: z.number().min(0), tone: z.enum(['paid', 'approved', 'free']) })).min(2).max(4),
  total: z.object({ label: z.string().min(1), value: z.number().positive() }),
  marker: z.object({ label: z.string().min(1), value: z.number().positive() }).optional(),
}).refine((s) => Math.abs(s.segments.reduce((a, x) => a + x.value, 0) - s.total.value) < 0.06, { message: 'segments must add up to the total' });

// The same actions on two bodies side by side, each panel with its own bar.
// `sources` names one path per row, panel by panel.
export const compareSpec = z.object({
  ...base,
  type: z.literal('compare'),
  panels: z.array(z.object({
    title: z.string().min(1),
    threshold: z.number().optional(),
    rows: z.array(z.object({ label: z.string().min(1), value: z.number(), tone: z.enum(['yes', 'no', 'abstain']).default('yes') })).min(1).max(4),
  })).min(2).max(3),
});

export const chartSpecSchema = z.discriminatedUnion('type', [lineSpec, linesSpec, stackedSpec, barsSpec, hbarsSpec, seatsSpec, scatterSpec, powerSpec, matrixSpec, beforeAfterSpec, timelineSpec, budgetSpec, compareSpec]);
// The renderers accept a spec as written (before defaults are filled in), not
// the parsed output, so callers don't have to spell out every field that has
// a schema default. z.input keeps those fields optional in the type, matching
// how a ```chart block or a hand-built test fixture actually looks.
export type ChartSpec = z.input<typeof chartSpecSchema>;
export type LineSpec = z.input<typeof lineSpec>;
export type LinesSpec = z.input<typeof linesSpec>;
export type StackedSpec = z.input<typeof stackedSpec>;
export type BarsSpec = z.input<typeof barsSpec>;
export type HbarsSpec = z.input<typeof hbarsSpec>;
export type SeatsSpec = z.input<typeof seatsSpec>;
export type ScatterSpec = z.input<typeof scatterSpec>;
export type PowerSpec = z.input<typeof powerSpec>;
export type MatrixSpec = z.input<typeof matrixSpec>;
export type BeforeAfterSpec = z.input<typeof beforeAfterSpec>;
export type TimelineSpec = z.input<typeof timelineSpec>;
export type BudgetSpec = z.input<typeof budgetSpec>;
export type CompareSpec = z.input<typeof compareSpec>;

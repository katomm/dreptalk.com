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

export const chartSpecSchema = z.discriminatedUnion('type', [lineSpec, linesSpec, stackedSpec, barsSpec, hbarsSpec, seatsSpec]);
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

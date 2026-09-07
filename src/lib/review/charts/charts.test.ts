import { describe, it, expect } from 'vitest';
import { renderChart, renderFigure } from './index.js';
import { chartSpecSchema } from './schema.js';

const line = {
  type: 'line' as const,
  title: 'Treasury balance',
  subtitle: 'Millions of ada',
  epochFrom: 630,
  values: [1632.6, 1636.4, null, 1643.8, 1516.1],
  yMin: 1300,
  yMax: 1700,
  format: 'M' as const,
  markers: [{ epoch: 634, label: '−131M' }],
  shade: [633, 634] as [number, number],
  caption: 'Steps are withdrawals.',
  sources: ['treasury.byEpochAda[].balanceAda'],
  epochSource: 'treasury.byEpochAda[].epoch',
};

describe('chart schema', () => {
  it('rejects an empty series and a lines chart with one series', () => {
    expect(chartSpecSchema.safeParse({ ...line, values: [] }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ type: 'lines', title: 't', xLabel: 'x', sources: ['a', 'b'], series: [{ name: 'a', values: [1, 2] }] }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...line, sources: [] }).success).toBe(false);
  });
});

describe('renderChart', () => {
  it('escapes labels', () => {
    const svg = renderChart({ ...line, title: 'a <b> & "c"', markers: [{ epoch: 634, label: '<img>' }] });
    expect(svg).not.toContain('<img>');
    expect(svg).toContain('&lt;img&gt;');
    expect(svg).toContain('aria-label="a &lt;b&gt; &amp; &quot;c&quot;. Millions of ada"');
  });
  it('renders a null as a gap, not a zero', () => {
    const svg = renderChart(line);
    const polylines = svg.match(/<polyline/g) ?? [];
    expect(polylines.length).toBe(2);
    expect(svg).not.toMatch(/,\s*260(\.\d+)?"/);
  });
  it('formats billions as billions and puts the formatted value in the tooltip', () => {
    const svg = renderChart({ ...line, format: 'B', values: [5.37, 5.13], yMin: 5, yMax: 6, markers: [], shade: undefined });
    expect(svg).toContain('<title>Epoch 630: 5.37B</title>');
    expect(svg).toContain('<title>Epoch 631: 5.13B</title>');
  });
  it('renders an all-zero series with finite coordinates', () => {
    for (const spec of [
      { type: 'bars' as const, title: 'quiet', sources: ['x'], epochSource: 'e', epochs: [650, 651, 652], values: [0, 0, 0] },
      { type: 'stacked' as const, title: 'quiet', sources: ['y', 'n', 'a'], epochSource: 'e', epochs: [650, 651], yes: [0, 0], no: [0, 0], abstain: [0, 0] },
      { type: 'lines' as const, title: 'flat', sources: ['a', 'b'], xLabel: 'x', series: [{ name: 'a', values: [0, 0] }, { name: 'b', values: [0, 0] }] },
      { type: 'hbars' as const, title: 'quiet', sources: ['r'], format: 'int' as const, rows: [{ label: 'a', value: 0, tone: 'yes' as const }] },
    ]) {
      const svg = renderChart(spec);
      expect(svg, spec.type).not.toMatch(/NaN|Infinity/);
    }
  });
  it('gives every mark a title', () => {
    for (const spec of [line,
      { type: 'bars' as const, title: 'b', sources: ['x'], epochSource: 'e', epochs: [1, 2, 3], values: [5, 6, 7], highlight: [2, 3] as [number, number] },
      { type: 'stacked' as const, title: 's', sources: ['y', 'n', 'a'], epochSource: 'e', epochs: [1, 2], yes: [1, 2], no: [0, 1], abstain: [1, 0] },
      { type: 'hbars' as const, title: 'h', sources: ['r'], format: '%' as const, threshold: 75, rows: [{ label: 'v2.0', value: 55.6, tone: 'no' as const }] },
      { type: 'lines' as const, title: 'l', sources: ['a', 'b'], xLabel: 'Epochs after submission', series: [{ name: 'a', values: [1, 2] }, { name: 'b', values: [2, 3] }] },
      { type: 'seats' as const, title: 'c', sources: ['g1', 'g2'], groups: [{ label: 'ends 653', count: 4, tone: 'ending' as const }, { label: 'to 726', count: 3, tone: 'staying' as const }] },
    ]) {
      const svg = renderChart(spec);
      const marks = (svg.match(/<(rect|circle)\b/g) ?? []).length;
      const titles = (svg.match(/<title>/g) ?? []).length;
      expect(titles, spec.type).toBeGreaterThanOrEqual(marks);
      expect(svg).toMatchSnapshot(spec.type);
    }
  });
});

describe('renderFigure', () => {
  it('adds a legend only for two or more series and a caption when given', () => {
    expect(renderFigure(line)).not.toContain('rv-legend');
    expect(renderFigure(line)).toContain('<figcaption>Steps are withdrawals.</figcaption>');
    const two = renderFigure({ type: 'lines', title: 'l', sources: ['a', 'b'], xLabel: 'x', series: [{ name: 'Van Rossem', values: [1] }, { name: 'Plomin', values: [2] }] });
    expect(two).toContain('rv-legend');
    expect(two).toContain('Van Rossem');
  });
});

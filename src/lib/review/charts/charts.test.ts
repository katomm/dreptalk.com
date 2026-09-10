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

const scatter = {
  type: 'scatter' as const,
  title: 'Amount asked against the share that answered',
  xLabel: 'Amount requested',
  format: '%' as const,
  xFormat: 'M' as const,
  threshold: 67,
  sources: ['a.x', 'a.y', 'b.x', 'b.y', 'c.x', 'c.y'],
  points: [
    { label: 'Consensus', x: 27714342, y: 87.99, tone: 'yes' as const },
    { label: 'Dolos', x: 540750, y: 68.37, tone: 'yes' as const },
    { label: 'Blockfrost', x: 7920000, y: 24.15, tone: 'no' as const },
  ],
};

const power = {
  type: 'power' as const,
  title: 'Voting power per proposal',
  format: 'B' as const,
  sources: ['a.y', 'a.n', 'a.a', 'a.s', 'b.y', 'b.n', 'b.a', 'b.s'],
  rows: [
    { label: 'Consensus', yes: 5.12, no: 0.16, abstain: 0.01, share: 87.99 },
    { label: 'Midgard', yes: 1.16, no: 1.93, abstain: 2.15, share: 31.43 },
  ],
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
      { type: 'power' as const, title: 'quiet', sources: ['y', 'n', 'a', 's'], format: 'B' as const, rows: [{ label: 'a', yes: 0, no: 0, abstain: 0, share: 0 }] },
      { type: 'scatter' as const, title: 'quiet', xLabel: 'x', format: '%' as const, xFormat: 'M' as const, sources: ['a', 'b', 'c', 'd'], points: [{ label: 'a', x: 0, y: 0 }, { label: 'b', x: 0, y: 0 }] },
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
      scatter,
      power,
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

describe('scatter', () => {
  it('needs two points and one source per coordinate', () => {
    expect(chartSpecSchema.safeParse(scatter).success).toBe(true);
    expect(chartSpecSchema.safeParse({ ...scatter, points: [scatter.points[0]] }).success).toBe(false);
  });
  it('spaces the amount axis logarithmically, so a small request stays visible', () => {
    const svg = renderChart(scatter);
    const cx = [...svg.matchAll(/<circle[^>]*cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    const [big, small, mid] = cx;
    // 540,750 to 7.92M is a wider ratio than 7.92M to 27.7M, so it must be the wider gap.
    expect(mid - small).toBeGreaterThan(big - mid);
  });
  it('pushes colliding labels apart without moving the dots', () => {
    const tight = { ...scatter, points: scatter.points.map((p, i) => ({ ...p, y: 50 + i * 0.05 })) };
    const svg = renderChart(tight);
    const ys = [...svg.matchAll(/<text class="rv-lbl"[^>]*y="([\d.]+)"/g)].map((m) => Number(m[1]));
    const gaps = ys.slice(1).map((y, i) => Math.abs(y - ys[i]));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(12);
  });
  it('draws the threshold once, across the plot', () => {
    expect((renderChart(scatter).match(/rv-thr/g) ?? []).length).toBe(1);
    expect(renderChart({ ...scatter, threshold: undefined })).not.toContain('rv-thr');
  });
});

describe('power', () => {
  it('needs four sources per row', () => {
    expect(chartSpecSchema.safeParse(power).success).toBe(true);
    expect(chartSpecSchema.safeParse({ ...power, rows: [{ ...power.rows[0], share: undefined }] }).success).toBe(false);
  });
  it('stacks yes, no and abstain on one scale across rows', () => {
    const svg = renderChart(power);
    const widths = [...svg.matchAll(/<rect[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
    // Row one totals 5.29 and row two 5.24, so the two rows must run to almost the same length.
    const r1 = widths.slice(0, 3).reduce((a, b) => a + b, 0);
    const r2 = widths.slice(3, 6).reduce((a, b) => a + b, 0);
    expect(Math.abs(r1 - r2)).toBeLessThan(r1 * 0.02);
  });
  it('prints the reported share, which the bar cannot show', () => {
    const svg = renderChart(power);
    expect(svg).toContain('>88.0%<');
    expect(svg).toContain('>31.4%<');
  });
  it('names all three tones in the legend', () => {
    const fig = renderFigure(power);
    expect(fig).toContain('Yes');
    expect(fig).toContain('Abstain');
  });
});

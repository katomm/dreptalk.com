// Entry point for the chart renderers. renderChart returns the bare <svg>,
// renderFigure wraps it in the figure markup the edition page styles.
import { chartSpecSchema, type ChartSpec } from './schema.js';
import { esc } from './svg.js';
import { renderLine } from './line.js';
import { renderLines } from './lines.js';
import { renderStacked } from './stacked.js';
import { renderBars } from './bars.js';
import { renderHbars } from './hbars.js';
import { renderSeats } from './seats.js';

export { chartSpecSchema, type ChartSpec };

export function renderChart(spec: ChartSpec): string {
  switch (spec.type) {
    case 'line': return renderLine(spec);
    case 'lines': return renderLines(spec);
    case 'stacked': return renderStacked(spec);
    case 'bars': return renderBars(spec);
    case 'hbars': return renderHbars(spec);
    case 'seats': return renderSeats(spec);
  }
}

function legendFor(spec: ChartSpec): string {
  const items: Array<[string, string]> =
    spec.type === 'lines' ? spec.series.map((s, i) => [s.name, i === 0 ? 's1' : 's2'])
    : spec.type === 'stacked' ? [['Yes', 's1'], ['No', 's2'], ['Abstain', 's3']]
    : spec.type === 'seats' ? spec.groups.map((g) => [g.label, g.tone])
    : [];
  if (items.length < 2) return '';
  return `<div class="rv-legend">${items.map(([n, t]) => `<span><i class="rv-${t}"></i>${esc(n)}</span>`).join('')}</div>`;
}

export function renderFigure(spec: ChartSpec): string {
  const sub = spec.subtitle ? `<p class="rv-chart__sub">${esc(spec.subtitle)}</p>` : '';
  const cap = spec.caption ? `<figcaption>${esc(spec.caption)}</figcaption>` : '';
  return `<figure class="rv-chart"><p class="rv-chart__title">${esc(spec.title)}</p>${sub}${legendFor(spec)}${renderChart(spec)}${cap}</figure>`;
}

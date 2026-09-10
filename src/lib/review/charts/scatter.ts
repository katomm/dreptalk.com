import { esc, fmt, frame, span, svgOpen, ticksFor, type Format } from './svg.js';
import type { ScatterSpec } from './schema.js';

/**
 * Amount asked against the share that answered. Amounts across a budget round
 * span three orders of magnitude, so the x axis is logarithmic, which keeps a
 * ₳540,750 request visible next to a ₳62M one. Ticks are the decades inside the
 * range, so the axis never claims a spacing it does not have.
 */
function decades(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(min)), hi = Math.ceil(Math.log10(max));
  return Array.from({ length: hi - lo + 1 }, (_, i) => 10 ** (lo + i)).filter((t) => t >= min && t <= max);
}

const unit = (f: Format) => (f === 'M' ? 1e6 : f === 'B' ? 1e9 : 1);

export function renderScatter(s: ScatterSpec): string {
  const W = 700, LABELS = 250, LEAD = 14;
  const yf = s.format as Format, xf = s.xFormat as Format;
  // Two points can sit on top of each other, so names live in a column at the
  // right with a leader back to the dot. Nothing depends on reading a name off
  // the position of a label.
  const H = Math.max(300, 60 + s.points.length * 17);
  const { fr, svg: grid } = frame(W, H, { l: 56, r: LABELS + LEAD, t: 16, b: 46 }, 0, yf === '%' ? 100 : span(0, Math.max(...s.points.map((p) => p.y)) * 1.1).max, ticksFor(0, yf === '%' ? 100 : span(0, Math.max(...s.points.map((p) => p.y)) * 1.1).max), yf);

  // A log axis has no room for zero, and a window where every request was zero
  // is not a chart. Fall back to a single decade so the frame still renders.
  const xs = s.points.map((p) => p.x).filter((v) => v > 0);
  const xMin = xs.length ? Math.min(...xs) / 1.8 : 1;
  const xMax = xs.length ? Math.max(...xs) * 1.8 : 10;
  const lg = (v: number) => Math.log10(Math.max(v, xMin));
  const x = (v: number) => fr.x0 + ((lg(v) - lg(xMin)) / (lg(xMax) - lg(xMin))) * (fr.x1 - fr.x0);

  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`) + grid;
  for (const t of decades(xMin, xMax)) {
    out += `<line class="rv-grid" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${fr.y1}" y2="${fr.y0}"/>`;
    out += `<text x="${x(t).toFixed(1)}" y="${fr.y0 + 18}" text-anchor="middle">${esc(fmt(t / unit(xf), xf))}</text>`;
  }
  out += `<text class="rv-muted" x="${fr.x0}" y="${fr.y0 + 36}">${esc(s.xLabel)}</text>`;

  if (s.threshold != null) {
    const ty = fr.y(s.threshold);
    out += `<line class="rv-thr" x1="${fr.x0}" x2="${fr.x1}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}"/>`;
    out += `<text class="rv-ann" x="${fr.x0 + 4}" y="${(ty - 6).toFixed(1)}">${esc(`${fmt(s.threshold, yf)} bar`)}</text>`;
  }

  const tone = { yes: 's1', no: 's2', abstain: 's3' } as const;
  const rows = s.points
    .map((p) => ({ p, cx: x(p.x), cy: fr.y(p.y) }))
    .sort((a, b) => a.cy - b.cy);
  // Labels keep their order and are pushed down only as far as they must be,
  // then the whole column is lifted back if it has run past the plot.
  const ly: number[] = [];
  let cursor = -Infinity;
  for (const r of rows) {
    cursor = Math.max(r.cy, cursor + 16);
    ly.push(cursor);
  }
  const overflow = ly[ly.length - 1] - fr.y0;
  if (overflow > 0) for (let i = ly.length - 1; i >= 0; i--) ly[i] = Math.min(ly[i], (ly[i + 1] ?? fr.y0 + 16) - 16);

  const lx = fr.x1 + LEAD;
  rows.forEach((r, i) => {
    out += `<polyline class="rv-lead" points="${(r.cx + 7).toFixed(1)},${r.cy.toFixed(1)} ${(fr.x1 + 6).toFixed(1)},${ly[i].toFixed(1)} ${lx.toFixed(1)},${ly[i].toFixed(1)}"/>`;
    out += `<circle class="rv-dot rv-${tone[r.p.tone ?? 'yes']}" cx="${r.cx.toFixed(1)}" cy="${r.cy.toFixed(1)}" r="5"><title>${esc(`${r.p.label}: ${fmt(r.p.x / unit(xf), xf)}, ${fmt(r.p.y, yf)}`)}</title></circle>`;
    out += `<text class="rv-lbl" x="${(lx + 5).toFixed(1)}" y="${(ly[i] + 4).toFixed(1)}">${esc(r.p.label)}</text>`;
  });
  return out + '</svg>';
}

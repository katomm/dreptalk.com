import { esc, fmt, span, svgOpen, thresholdLabel, type Format } from './svg.js';
import type { HbarsSpec } from './schema.js';

// Rough width of a label in the chart's text size, enough to keep a long row
// label inside the frame and a value label off the threshold line.
const textWidth = (t: string) => t.length * 7.2;

export function renderHbars(s: HbarsSpec): string {
  const W = 700, rowH = 38, top = 22;
  const H = top + s.rows.length * rowH + 22;
  const max = s.max ?? (s.format === '%' ? 100 : span(0, Math.max(...s.rows.map((r) => r.value)) * 1.15).max);
  // The label column grows with the longest row label instead of letting it run
  // out of the frame on the left.
  const x0 = Math.min(320, Math.max(170, 16 + Math.max(...s.rows.map((r) => textWidth(r.label)))));
  const x1 = W - 60;
  const x = (v: number) => x0 + (v / max) * (x1 - x0);
  const tx = s.threshold != null ? x(s.threshold) : null;
  const tone = { yes: 's1', no: 's2', abstain: 's3' } as const;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  s.rows.forEach((r, i) => {
    const y = top + i * rowH + 8;
    const label = fmt(r.value, s.format as Format);
    // A value label that would sit on the threshold line moves past it.
    let lx = x(r.value) + 6;
    if (tx != null && lx - 4 < tx + 4 && lx + textWidth(label) > tx - 4) lx = tx + 8;
    out += `<text x="${x0 - 12}" y="${y + 15}" text-anchor="end">${esc(r.label)}</text>`;
    out += `<rect class="rv-bar rv-${tone[r.tone ?? 'yes']}" x="${x0}" y="${y}" width="${Math.max(3, x(r.value) - x0).toFixed(1)}" height="22" rx="3"><title>${esc(`${r.label}: ${label}`)}</title></rect>`;
    out += `<text class="rv-lbl" x="${lx.toFixed(1)}" y="${y + 15}">${esc(label)}</text>`;
  });
  if (tx != null && s.threshold != null) {
    out += `<line class="rv-thr" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${top - 4}" y2="${top + s.rows.length * rowH}"/>`;
    out += `<text class="rv-ann" x="${(tx + 5).toFixed(1)}" y="${top - 8}">${esc(thresholdLabel(s.threshold, s.format as Format))}</text>`;
  }
  return out + '</svg>';
}

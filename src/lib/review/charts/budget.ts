import { esc, svgOpen, type Format } from './svg.js';
import type { BudgetSpec } from './schema.js';

/**
 * A spending limit as one bar: what has been paid, what is approved but not
 * yet paid, and what is left, adding up to the ceiling. A marker draws an
 * earlier ceiling on the same scale, so a raise reads as the distance between
 * the two. Amounts print with one decimal in millions.
 */
const fmtM = (v: number, f: Format) => (f === 'M' ? `₳${v.toFixed(1)}M` : f === 'B' ? `₳${v.toFixed(2)}B` : String(v));

export function renderBudget(s: BudgetSpec): string {
  const W = 700, H = 132, x0 = 20, x1 = W - 20, y = 44, h = 34;
  const f = s.format as Format;
  const x = (v: number) => x0 + (v / s.total.value) * (x1 - x0);
  const tone = { paid: 's2', approved: 's1', free: 'none' } as const;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  let acc = 0;
  s.segments.forEach((seg) => {
    const sx = x(acc), w = x(acc + seg.value) - sx;
    out += `<rect class="rv-seg rv-${tone[seg.tone]}" x="${sx.toFixed(1)}" y="${y}" width="${Math.max(1, w).toFixed(1)}" height="${h}"><title>${esc(`${seg.label}: ${fmtM(seg.value, f)}`)}</title></rect>`;
    const mid = sx + w / 2;
    if (w > 46) out += `<text class="rv-lbl" x="${mid.toFixed(1)}" y="${y + h / 2 + 4}" text-anchor="middle">${esc(fmtM(seg.value, f))}</text>`;
    out += `<text x="${(w > 46 ? mid : sx + w / 2).toFixed(1)}" y="${y + h + 16}" text-anchor="${w > 46 ? 'middle' : 'start'}">${esc(seg.label)}</text>`;
    acc += seg.value;
  });
  out += `<rect class="rv-frame" x="${x0}" y="${y}" width="${(x1 - x0).toFixed(1)}" height="${h}" rx="3"/>`;
  out += `<text class="rv-lbl" x="${x1}" y="${y - 10}" text-anchor="end">${esc(`${s.total.label}: ${fmtM(s.total.value, f)}`)}</text>`;
  if (s.marker) {
    const mx = x(s.marker.value);
    out += `<line class="rv-thr" x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="${y - 14}" y2="${y + h + 6}"/>`;
    out += `<text class="rv-ann" x="${(mx - 6).toFixed(1)}" y="${y - 18}" text-anchor="end">${esc(`${s.marker.label}: ${fmtM(s.marker.value, f)}`)}</text>`;
  }
  return out + '</svg>';
}

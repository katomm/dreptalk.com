import { esc, fmt, span, svgOpen, type Format } from './svg.js';
import type { HbarsSpec } from './schema.js';

export function renderHbars(s: HbarsSpec): string {
  const W = 700, rowH = 38, top = 14;
  const H = top + s.rows.length * rowH + 30;
  const max = s.max ?? (s.format === '%' ? 100 : span(0, Math.max(...s.rows.map((r) => r.value)) * 1.15).max);
  const x0 = 170, x1 = W - 60;
  const x = (v: number) => x0 + (v / max) * (x1 - x0);
  const tone = { yes: 's1', no: 's2', abstain: 's3' } as const;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  s.rows.forEach((r, i) => {
    const y = top + i * rowH + 8;
    out += `<text x="${x0 - 12}" y="${y + 15}" text-anchor="end">${esc(r.label)}</text>`;
    out += `<rect class="rv-bar rv-${tone[r.tone ?? 'yes']}" x="${x0}" y="${y}" width="${Math.max(3, x(r.value) - x0).toFixed(1)}" height="22" rx="3"><title>${esc(`${r.label}: ${fmt(r.value, s.format as Format)}`)}</title></rect>`;
    out += `<text class="rv-lbl" x="${(x(r.value) + 6).toFixed(1)}" y="${y + 15}">${esc(fmt(r.value, s.format as Format))}</text>`;
  });
  if (s.threshold != null) {
    out += `<line class="rv-thr" x1="${x(s.threshold).toFixed(1)}" x2="${x(s.threshold).toFixed(1)}" y1="${top - 4}" y2="${top + s.rows.length * rowH}"/>`;
    out += `<text class="rv-ann" x="${(x(s.threshold) + 5).toFixed(1)}" y="${top + 2}">${esc(`${fmt(s.threshold, s.format as Format)} bar`)}</text>`;
  }
  return out + '</svg>';
}

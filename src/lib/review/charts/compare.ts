import { esc, fmt, svgOpen, type Format } from './svg.js';
import type { CompareSpec } from './schema.js';

/**
 * The same actions on two bodies, side by side, each panel with its own bar:
 * DReps against 67% next to pools against 51%. A reader sees at once where
 * the support was enough and where it was not, without reading two charts
 * against two thresholds in their head.
 */
export function renderCompare(s: CompareSpec): string {
  const W = 700, gap = 40, LABELS = 120, rowH = 34, top = 28;
  const n = s.panels.length;
  const pw = (W - gap * (n - 1)) / n;
  const rows = Math.max(...s.panels.map((p) => p.rows.length));
  const H = top + rows * rowH + 14;
  const f = s.format as Format;
  const max = f === '%' ? 100 : Math.max(...s.panels.flatMap((p) => p.rows.map((r) => r.value))) * 1.15;
  const tone = { yes: 's1', no: 's2', abstain: 's3' } as const;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  s.panels.forEach((p, k) => {
    const px = k * (pw + gap), x0 = px + LABELS, x1 = px + pw - 48;
    const x = (v: number) => x0 + (v / max) * (x1 - x0);
    out += `<text class="rv-lbl" x="${px}" y="14">${esc(p.title)}</text>`;
    p.rows.forEach((r, i) => {
      const y = top + i * rowH + 4;
      out += `<text x="${x0 - 8}" y="${y + 15}" text-anchor="end">${esc(r.label)}</text>`;
      out += `<rect class="rv-bar rv-${tone[r.tone ?? 'yes']}" x="${x0}" y="${y}" width="${Math.max(3, x(r.value) - x0).toFixed(1)}" height="22" rx="3"><title>${esc(`${p.title}, ${r.label}: ${fmt(r.value, f)}`)}</title></rect>`;
      out += `<text class="rv-lbl" x="${(x(r.value) + 6).toFixed(1)}" y="${y + 15}">${esc(fmt(r.value, f))}</text>`;
    });
    if (p.threshold != null) {
      const tx = x(p.threshold);
      out += `<line class="rv-thr" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${top - 6}" y2="${top + p.rows.length * rowH + 2}"/>`;
      out += `<text class="rv-ann" x="${(tx + 4).toFixed(1)}" y="${top - 8}">${esc(`${fmt(p.threshold, f)} bar`)}</text>`;
    }
  });
  return out + '</svg>';
}

import { esc, fmt as baseFmt, svgOpen, type Format } from './svg.js';

/** A moved amount keeps one decimal, so ₳39.8M does not print as 40M next to ₳18.3M. */
const fmt = (v: number, f: Format): string => (f === 'M' && !Number.isInteger(v) ? `${v.toFixed(1)}M` : baseFmt(v, f));
import type { BeforeAfterSpec } from './schema.js';

/**
 * A request that came back: one row per measure (the sum asked, the share it
 * reached), two dots joined by a line, each row on its own scale so an amount
 * in millions and a share in percent sit under each other without pretending
 * to share an axis. A threshold draws the bar the share had to reach.
 */
export function renderBeforeAfter(s: BeforeAfterSpec): string {
  const W = 700, LABELS = 150, rowH = 74, top = 10, x0 = LABELS, x1 = W - 90;
  const H = top + s.panels.length * rowH;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  s.panels.forEach((p, i) => {
    const f = (p.format ?? 'int') as Format;
    const max = f === '%' ? 100 : Math.max(p.before.value, p.after.value, p.threshold ?? 0) * 1.15;
    const x = (v: number) => x0 + (v / max) * (x1 - x0);
    const y = top + i * rowH + 38;
    out += `<text class="rv-lbl" x="${x0 - 14}" y="${y + 4}" text-anchor="end">${esc(p.label)}</text>`;
    out += `<line class="rv-axis" x1="${x0}" x2="${x1}" y1="${y}" y2="${y}"/>`;
    if (p.threshold != null) {
      out += `<line class="rv-thr" x1="${x(p.threshold).toFixed(1)}" x2="${x(p.threshold).toFixed(1)}" y1="${y - 22}" y2="${y + 22}"/>`;
      out += `<text class="rv-ann" x="${(x(p.threshold) + 5).toFixed(1)}" y="${y - 24}">${esc(`${fmt(p.threshold, f)} bar`)}</text>`;
    }
    const bx = x(p.before.value), ax = x(p.after.value);
    out += `<line class="rv-link" x1="${bx.toFixed(1)}" x2="${ax.toFixed(1)}" y1="${y}" y2="${y}"/>`;
    out += `<circle class="rv-dot rv-s3" cx="${bx.toFixed(1)}" cy="${y}" r="7"><title>${esc(`${p.before.label}: ${fmt(p.before.value, f)}`)}</title></circle>`;
    out += `<circle class="rv-dot rv-s1" cx="${ax.toFixed(1)}" cy="${y}" r="7"><title>${esc(`${p.after.label}: ${fmt(p.after.value, f)}`)}</title></circle>`;
    // Value labels sit below the dots, the names above, so a short move still reads.
    const below = (cx: number, v: number) => `<text class="rv-lbl" x="${cx.toFixed(1)}" y="${y + 24}" text-anchor="middle">${esc(fmt(v, f))}</text>`;
    out += below(bx, p.before.value) + below(ax, p.after.value);
  });
  return out + '</svg>';
}

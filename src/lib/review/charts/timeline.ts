import { esc, svgOpen } from './svg.js';
import type { TimelineSpec } from './schema.js';

/**
 * A few dated events on one epoch axis, for a story that turns on order: a
 * revised request filed before the first expired, a limit raised before the
 * withdrawal that needed it. Labels alternate above and below the axis so
 * events in neighbouring epochs do not overprint.
 */
export function renderTimeline(s: TimelineSpec): string {
  const W = 700, H = 150, x0 = 40, x1 = W - 40, axisY = 78;
  const epochs = s.items.map((i) => i.epoch);
  const lo = Math.min(...epochs) - 1, hi = Math.max(...epochs) + 1;
  const x = (e: number) => x0 + ((e - lo) / (hi - lo)) * (x1 - x0);
  const tone = { yes: 's1', no: 's2', abstain: 's3' } as const;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  out += `<line class="rv-axis" x1="${x0}" x2="${x1}" y1="${axisY}" y2="${axisY}"/>`;
  const step = hi - lo > 14 ? Math.ceil((hi - lo) / 14) : 1;
  for (let e = lo; e <= hi; e += step) {
    out += `<line class="rv-grid" x1="${x(e).toFixed(1)}" x2="${x(e).toFixed(1)}" y1="${axisY - 4}" y2="${axisY + 4}"/>`;
    out += `<text x="${x(e).toFixed(1)}" y="${axisY + 20}" text-anchor="middle">${e}</text>`;
  }
  out += `<text class="rv-muted" x="${x0}" y="${H - 6}">Epoch</text>`;
  s.items.forEach((it, i) => {
    const cx = x(it.epoch), above = i % 2 === 0;
    const ly = above ? axisY - 30 : axisY + 44;
    out += `<line class="rv-lead" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${axisY}" y2="${(above ? ly + 6 : ly - 12).toFixed(1)}"/>`;
    out += `<circle class="rv-dot rv-${tone[it.tone ?? 'yes']}" cx="${cx.toFixed(1)}" cy="${axisY}" r="6"><title>${esc(`Epoch ${it.epoch}: ${it.label}`)}</title></circle>`;
    const anchor = cx < x0 + 90 ? 'start' : cx > x1 - 90 ? 'end' : 'middle';
    out += `<text class="rv-lbl" x="${cx.toFixed(1)}" y="${ly}" text-anchor="${anchor}">${esc(it.label)}</text>`;
  });
  return out + '</svg>';
}

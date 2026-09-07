import { esc, svgOpen } from './svg.js';
import type { SeatsSpec } from './schema.js';

/**
 * What a seat prints inside its own box. The full group label ("ends 653") is
 * wider than the box, so only the epoch number the label ends on goes inside
 * and the legend carries the words. A label without a trailing number prints
 * nothing rather than an overhanging string.
 */
function seatNumber(label: string): string {
  return /(\d+)\s*$/.exec(label)?.[1] ?? '';
}

export function renderSeats(s: SeatsSpec): string {
  const size = 64, gap = 10;
  const total = s.groups.reduce((a, g) => a + g.count, 0);
  const W = Math.max(300, total * (size + gap) + 20), H = size + 44;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  let i = 0;
  for (const g of s.groups) {
    const inside = seatNumber(g.label);
    for (let k = 0; k < g.count; k++) {
      const x = 10 + i * (size + gap);
      out += `<rect class="rv-seat rv-${g.tone}" x="${x}" y="8" width="${size}" height="${size}" rx="6"><title>${esc(g.label)}</title></rect>`;
      if (inside) out += `<text class="rv-lbl" x="${x + size / 2}" y="${8 + size / 2 + 4}" text-anchor="middle">${esc(inside)}</text>`;
      i++;
    }
  }
  return out + '</svg>';
}

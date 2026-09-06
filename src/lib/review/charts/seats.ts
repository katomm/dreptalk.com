import { esc, svgOpen } from './svg.js';
import type { SeatsSpec } from './schema.js';

export function renderSeats(s: SeatsSpec): string {
  const size = 64, gap = 10;
  const total = s.groups.reduce((a, g) => a + g.count, 0);
  const W = Math.max(300, total * (size + gap) + 20), H = size + 44;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  let i = 0;
  for (const g of s.groups) {
    for (let k = 0; k < g.count; k++) {
      const x = 10 + i * (size + gap);
      out += `<rect class="rv-seat rv-${g.tone}" x="${x}" y="8" width="${size}" height="${size}" rx="6"><title>${esc(g.label)}</title></rect>`;
      out += `<text class="rv-lbl" x="${x + 8}" y="${8 + size - 8}">${esc(g.label)}</text>`;
      i++;
    }
  }
  return out + '</svg>';
}

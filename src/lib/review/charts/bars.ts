import { esc, fmt, frame, span, svgOpen, ticksFor, type Format } from './svg.js';
import type { BarsSpec } from './schema.js';

export function renderBars(s: BarsSpec): string {
  const W = 700, H = 220;
  const { max: yMax } = span(0, Math.max(...s.values) * 1.1);
  const { fr, svg: grid } = frame(W, H, { l: 48, r: 20, t: 14, b: 30 }, 0, yMax, ticksFor(0, yMax), s.format as Format);
  const n = s.epochs.length;
  const x = (i: number) => fr.x0 + ((i + 0.5) / n) * (fr.x1 - fr.x0);
  const bw = Math.min(40, ((fr.x1 - fr.x0) / n) * 0.7);
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`) + grid;
  s.epochs.forEach((e, i) => {
    const inWin = s.highlight ? e >= s.highlight[0] && e <= s.highlight[1] : true;
    out += `<text x="${x(i).toFixed(1)}" y="${fr.y0 + 18}" text-anchor="middle">${e}</text>`;
    out += `<rect class="rv-bar rv-s1${inWin ? '' : ' rv-dim'}" x="${(x(i) - bw / 2).toFixed(1)}" y="${fr.y(s.values[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(fr.y0 - fr.y(s.values[i])).toFixed(1)}" rx="3"><title>${esc(`Epoch ${e}: ${fmt(s.values[i], s.format as Format)}`)}</title></rect>`;
  });
  return out + '</svg>';
}

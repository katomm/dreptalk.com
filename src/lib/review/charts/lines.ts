import { esc, fmt, frame, span, svgOpen, ticksFor, type Format } from './svg.js';
import type { LinesSpec } from './schema.js';

export function renderLines(s: LinesSpec): string {
  const W = 700, H = 260;
  const all = s.series.flatMap((x) => x.values);
  const { max: yMax } = span(0, Math.max(...all) * 1.05);
  const { fr, svg: grid } = frame(W, H, { l: 56, r: 20, t: 16, b: 40 }, 0, yMax, ticksFor(0, yMax), s.format as Format);
  const n = Math.max(...s.series.map((x) => x.values.length));
  const x = (i: number) => fr.x0 + (i / Math.max(1, n - 1)) * (fr.x1 - fr.x0);
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`) + grid;
  for (let i = 0; i < n; i++) out += `<text x="${x(i).toFixed(1)}" y="${fr.y0 + 18}" text-anchor="middle">+${i}</text>`;
  out += `<text class="rv-muted" x="${fr.x0}" y="${fr.y0 + 34}">${esc(s.xLabel)}</text>`;
  s.series.forEach((ser, k) => {
    const tone = k === 0 ? 's1' : 's2';
    out += `<polyline class="rv-line rv-${tone}" points="${ser.values.map((v, i) => `${x(i).toFixed(1)},${fr.y(v).toFixed(1)}`).join(' ')}"/>`;
    ser.values.forEach((v, i) => {
      out += `<circle class="rv-dot rv-${tone}" cx="${x(i).toFixed(1)}" cy="${fr.y(v).toFixed(1)}" r="4"><title>${esc(`${ser.name}, +${i}: ${fmt(v, s.format as Format)}`)}</title></circle>`;
    });
    const last = ser.values.length - 1;
    out += `<text class="rv-ann" x="${(x(last) + 8).toFixed(1)}" y="${(fr.y(ser.values[last]) + 4).toFixed(1)}">${esc(ser.name)}</text>`;
  });
  return out + '</svg>';
}

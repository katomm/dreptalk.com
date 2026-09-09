import { esc, fmt, frame, marker, svgOpen, ticksFor, type Format } from './svg.js';
import type { LineSpec } from './schema.js';

export function renderLine(s: LineSpec): string {
  const W = 700, H = 260;
  const { fr, svg: grid } = frame(W, H, { l: 56, r: 20, t: 16, b: 34 }, s.yMin, s.yMax, ticksFor(s.yMin, s.yMax), s.format as Format);
  const n = s.values.length;
  const x = (i: number) => fr.x0 + (i / (n - 1)) * (fr.x1 - fr.x0);
  const epochAt = (i: number) => s.epochFrom + i;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`) + grid;
  if (s.shade) {
    const a = Math.max(0, s.shade[0] - s.epochFrom), b = Math.min(n - 1, s.shade[1] - s.epochFrom);
    out += `<rect class="rv-shade" x="${x(a).toFixed(1)}" y="${fr.y1}" width="${(x(b) - x(a)).toFixed(1)}" height="${fr.y0 - fr.y1}"><title>${esc(`Epoch ${s.shade[0]} to ${s.shade[1]}`)}</title></rect>`;
  }
  // one polyline per run of non-null values, so a null shows as a gap
  const runs: number[][] = [];
  let run: number[] = [];
  s.values.forEach((v, i) => { if (v == null) { if (run.length) runs.push(run); run = []; } else run.push(i); });
  if (run.length) runs.push(run);
  for (const r of runs) {
    const pts = r.map((i) => `${x(i).toFixed(1)},${fr.y(s.values[i] as number).toFixed(1)}`).join(' ');
    if (s.area) out += `<polygon class="rv-area" points="${pts} ${x(r[r.length - 1]).toFixed(1)},${fr.y0} ${x(r[0]).toFixed(1)},${fr.y0}"/>`;
    out += `<polyline class="rv-line rv-s1" points="${pts}"/>`;
  }
  s.values.forEach((v, i) => {
    if (v == null) return;
    out += `<circle class="rv-hit" cx="${x(i).toFixed(1)}" cy="${fr.y(v).toFixed(1)}" r="7"><title>${esc(`Epoch ${epochAt(i)}: ${fmt(v, s.format as Format)}`)}</title></circle>`;
    // The ends are always labelled, so a short window is readable at all, and
    // the multiples of five in between carry the rest without crowding them.
    const end = i === 0 || i === n - 1;
    const inner = epochAt(i) % 5 === 0 && i > 1 && i < n - 2;
    if (end || inner) out += `<text x="${x(i).toFixed(1)}" y="${fr.y0 + 18}" text-anchor="middle">${epochAt(i)}</text>`;
  });
  for (const m of s.markers ?? []) {
    const i = m.epoch - s.epochFrom;
    const v = s.values[i];
    if (i < 0 || i >= n || v == null) continue;
    const left = i > n * 0.7;
    out += marker(x(i), fr.y(v), 's2', `Epoch ${m.epoch}: ${m.label}`);
    out += `<text class="rv-ann" x="${(x(i) + (left ? -8 : 8)).toFixed(1)}" y="${(fr.y(v) - 10).toFixed(1)}" text-anchor="${left ? 'end' : 'start'}">${esc(m.label)}</text>`;
  }
  return out + '</svg>';
}

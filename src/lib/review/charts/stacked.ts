import { esc, fmt, frame, span, svgOpen, ticksFor, type Format } from './svg.js';
import type { StackedSpec } from './schema.js';

export function renderStacked(s: StackedSpec): string {
  const W = 700, H = 260;
  const totals = s.epochs.map((_, i) => s.yes[i] + s.no[i] + s.abstain[i]);
  const { max: yMax } = span(0, Math.max(...totals) * 1.08);
  const f = s.format as Format;
  const { fr, svg: grid } = frame(W, H, { l: 56, r: 20, t: 16, b: 34 }, 0, yMax, ticksFor(0, yMax), f);
  const n = s.epochs.length;
  const x = (i: number) => fr.x0 + ((i + 0.5) / n) * (fr.x1 - fr.x0);
  const bw = Math.min(44, ((fr.x1 - fr.x0) / n) * 0.7);
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`) + grid;
  s.epochs.forEach((e, i) => {
    out += `<text x="${x(i).toFixed(1)}" y="${fr.y0 + 18}" text-anchor="middle">${e}</text>`;
    let base = 0;
    for (const [v, tone, name] of [[s.yes[i], 's1', 'Yes'], [s.no[i], 's2', 'No'], [s.abstain[i], 's3', 'Abstain']] as const) {
      if (!v) continue;
      const top = fr.y(base + v), h = fr.y(base) - top;
      out += `<rect class="rv-bar rv-${tone}" x="${(x(i) - bw / 2).toFixed(1)}" y="${(top + 1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - 2).toFixed(1)}" rx="2"><title>${esc(`Epoch ${e}, ${name}: ${fmt(v, f)}`)}</title></rect>`;
      base += v;
    }
  });
  return out + '</svg>';
}
